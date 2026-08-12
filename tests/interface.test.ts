// The half of the terminal interface that owns the database: what a command
// line with no command means, what a view gathered from a real Hub says, and
// what the settings surface is allowed to write.
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { parseArgs } from "../src/args.js";
import { identityConfig } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { createInvite } from "../src/identity/invites.js";
import { identityLayout } from "../src/identity/layout.js";
import { defaultPasswordHasher } from "../src/identity/passwords.js";
import { createUser, disableUser } from "../src/identity/users.js";
import { readDuration } from "../src/interface.js";
import { DEFAULT_PORTS } from "../src/loreserver/layout.js";
import { createProject, grantAccess, newProjectId } from "../src/projects/registry.js";
import { gatherHubView, settingRows, type ViewContext } from "../src/view.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlhub-interface-");

const open: DatabaseSync[] = [];

afterEach(() => {
  while (open.length > 0) {
    open.pop()?.close();
  }
});

/** A Hub with two accounts, a project and an invitation outstanding. */
async function hub(): Promise<ViewContext> {
  const root = await temporaryRoot();
  const database = await openMigratedDatabase(identityLayout(root).databasePath);
  open.push(database);

  const hasher = defaultPasswordHasher();
  const ada = await createUser(database, hasher, {
    username: "ada",
    password: "correct horse battery",
    displayName: "Ada Blackwood",
    groups: ["owner"],
  });
  const bob = await createUser(database, hasher, {
    username: "bob",
    password: "correct horse battery",
    displayName: "Bob Reyes",
    groups: ["member"],
  });
  disableUser(database, "bob");

  const harbour = createProject(database, {
    id: newProjectId(),
    name: "harbour",
    description: "the one everybody is working on",
    createdBy: ada.id,
  });
  grantAccess(database, harbour.id, bob.id, "read", ada.id);
  createInvite(database, {});

  return {
    root,
    database,
    config: identityConfig({}),
    healthPort: DEFAULT_PORTS.healthPort,
    fingerprint: "22:3B:65:91:89:41:E6:D7",
  };
}

describe("a command line that names no command", () => {
  it("opens the interface on a root", () => {
    expect(parseArgs(["--root", "/srv/hub"])).toEqual({
      kind: "interface",
      root: "/srv/hub",
      healthPort: DEFAULT_PORTS.healthPort,
      overrides: {},
    });
  });

  it("takes the identity settings, because the interface shows them", () => {
    // A Hub brought up with a different data port is reached at that port
    // whether or not the screen showing the address was told about it.
    const invocation = parseArgs(["--root", "/srv/hub", "--data-port", "41500"]);
    expect(invocation.kind === "interface" && invocation.overrides.dataPort).toBe(41500);
  });

  it("asks for a root rather than guessing at one", () => {
    const invocation = parseArgs(["--health-port", "41339"]);
    expect(invocation.kind).toBe("error");
    expect(invocation.kind === "error" && invocation.message).toContain("--root");
  });

  it("still reports an option nobody has", () => {
    const invocation = parseArgs(["--nonsense"]);
    expect(invocation.kind).toBe("error");
    expect(invocation.kind === "error" && invocation.message).toContain("--nonsense");
  });
});

describe("the view a real Hub gathers", () => {
  it("says who is here, what they can reach, and which of them is disabled", async () => {
    const view = await gatherHubView(await hub());

    expect(view.users.map((user) => user.username)).toEqual(["ada", "bob"]);
    expect(view.users.find((user) => user.username === "bob")?.disabled).toBe(true);
    expect(view.users.find((user) => user.username === "bob")?.projects).toEqual([
      { name: "harbour", level: "read" },
    ]);
    expect(view.invitesLive).toBe(1);
  });

  it("names the owner of a project and everybody with a grant on it", async () => {
    const view = await gatherHubView(await hub());
    const harbour = view.projects[0];

    expect(harbour?.name).toBe("harbour");
    expect(harbour?.owner).toBe("ada");
    expect(harbour?.access).toEqual([
      { username: "ada", level: "owner" },
      { username: "bob", level: "read" },
    ]);
  });

  it("leaves out what lives inside a repository, rather than making it up", async () => {
    // The revision history and the project file belong to loreserver, which
    // holds an exclusive lock on the store it is serving. Absent is what the
    // interface draws as unknown; a zero here would be a claim.
    const view = await gatherHubView(await hub());
    const harbour = view.projects[0];

    expect(harbour?.file.readable).toBe(false);
    expect(harbour?.file.reason).toBeDefined();
    expect(harbour?.history.lastAt).toBeUndefined();
    expect(harbour?.history.bytes).toBeUndefined();
  });

  it("measures every relative time against the moment it was gathered", async () => {
    const view = await gatherHubView(await hub());
    expect(view.now).toBeLessThanOrEqual(Date.now());
    expect(view.server.healthCheckedAt).toBe(view.now);
  });
});

describe("what the settings surface may change", () => {
  it("marks a row editable only where Hub has somewhere to put the value", async () => {
    const rows = settingRows(await hub());
    const editable = rows.filter((row) => row.editable).map((row) => row.label);

    // The rest are named on the command line that started up, so an editor
    // over them would be writing somewhere nothing reads.
    expect(editable).toEqual(["sign-in token", "repository token"]);
  });

  it("says of the repository token the one thing that is not obvious about it", async () => {
    const rows = settingRows(await hub());
    const repository = rows.find((row) => row.label === "repository token");

    expect(repository?.caution).toContain("without asking Hub");
  });
});

describe("readDuration", () => {
  it("takes back the words the editor opened on", () => {
    expect(readDuration("30 days")).toBe(30 * 24 * 60 * 60);
    expect(readDuration("15 minutes")).toBe(15 * 60);
    expect(readDuration("1 hour")).toBe(60 * 60);
  });

  it("takes the spelling every command line here takes", () => {
    expect(readDuration("7d")).toBe(7 * 24 * 60 * 60);
    expect(readDuration("90")).toBe(90);
  });

  it("answers with a sentence rather than a number it invented", () => {
    expect(typeof readDuration("whenever")).toBe("string");
  });
});
