import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { openMigratedDatabase } from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { createUser } from "../src/identity/users.js";
import {
  accessLevel,
  createProject,
  forgetProject,
  grantAccess,
  InvalidProjectNameError,
  levelAllows,
  listGrants,
  listProjects,
  listProjectsFor,
  newProjectId,
  OwnerGrantError,
  permissionsFor,
  ProjectNameTakenError,
  projectIdFromResourceId,
  requireProject,
  resourceIdOf,
  revokeAccess,
  UnknownProjectError,
} from "../src/projects/registry.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-projects-");

/** Cheap parameters: these tests are about the rows, not the cost of a hash. */
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);

const open: DatabaseSync[] = [];

afterEach(() => {
  while (open.length > 0) {
    open.pop()?.close();
  }
});

async function database(): Promise<DatabaseSync> {
  const connection = await openMigratedDatabase(identityLayout(await temporaryRoot()).databasePath);
  open.push(connection);
  return connection;
}

async function account(connection: DatabaseSync, username: string): Promise<string> {
  const user = await createUser(connection, hasher, {
    username,
    password: "a password nobody guesses",
  });
  return user.id;
}

describe("resource ids", () => {
  it("is the repository id with the prefix loreserver asks with", () => {
    const id = newProjectId();

    expect(resourceIdOf(id)).toBe(`urc-${id}`);
    expect(projectIdFromResourceId(resourceIdOf(id))).toBe(id);
    // Hex is hex in either case, so a shouted resource id names the same
    // project. What it does not do is change the string that goes back in the
    // answer, which loreserver compares character by character.
    expect(projectIdFromResourceId(resourceIdOf(id).toUpperCase())).toBe(id);
  });

  it("generates sixteen bytes, as hex, and a different one every time", () => {
    const first = newProjectId();

    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(newProjectId()).not.toBe(first);
  });

  it("recognises nothing else as one of Team's", () => {
    // A resource loreserver invented for something other than a repository has
    // to answer "not a project here" rather than fall through to a lookup.
    expect(projectIdFromResourceId("urc-not-hex")).toBeUndefined();
    expect(projectIdFromResourceId(newProjectId())).toBeUndefined();
    expect(projectIdFromResourceId(`urc-${newProjectId()}extra`)).toBeUndefined();
    expect(projectIdFromResourceId("")).toBeUndefined();
  });
});

describe("createProject", () => {
  it("records the project and makes its creator the owner in one step", async () => {
    const connection = await database();
    const ada = await account(connection, "ada");

    const project = createProject(connection, {
      id: newProjectId(),
      name: "moonlit-harbour",
      description: "a game about a port at night",
      createdBy: ada,
    });

    expect(project.name).toBe("moonlit-harbour");
    expect(project.createdBy).toBe(ada);
    // A project row with no grant would be a repository its own author could
    // not open, so the two are written together or not at all.
    expect(accessLevel(connection, project.id, ada)).toBe("owner");
    expect(listGrants(connection, project.id)).toHaveLength(1);
  });

  it("refuses a second project of the same name", async () => {
    const connection = await database();
    const ada = await account(connection, "ada");
    createProject(connection, { id: newProjectId(), name: "harbour", createdBy: ada });

    expect(() =>
      createProject(connection, { id: newProjectId(), name: "harbour", createdBy: ada }),
    ).toThrow(ProjectNameTakenError);
    expect(listProjects(connection)).toHaveLength(1);
  });

  it("refuses a name loreserver would not take", async () => {
    const connection = await database();
    const ada = await account(connection, "ada");

    expect(() =>
      createProject(connection, { id: newProjectId(), name: "a name with spaces", createdBy: ada }),
    ).toThrow(InvalidProjectNameError);
  });

  it("finds a project by its name or by its repository id", async () => {
    const connection = await database();
    const ada = await account(connection, "ada");
    const project = createProject(connection, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada,
    });

    expect(requireProject(connection, "harbour").id).toBe(project.id);
    expect(requireProject(connection, project.id).name).toBe("harbour");
    expect(() => requireProject(connection, "nothing")).toThrow(UnknownProjectError);
  });
});

describe("grants", () => {
  it("decides what one account may do, and says nothing about another", async () => {
    const connection = await database();
    const ada = await account(connection, "ada");
    const bob = await account(connection, "bob");
    const project = createProject(connection, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada,
    });

    expect(accessLevel(connection, project.id, bob)).toBeUndefined();
    grantAccess(connection, project.id, bob, "read", ada);
    expect(accessLevel(connection, project.id, bob)).toBe("read");

    // Granting again is how a level is changed; it is not a second row.
    grantAccess(connection, project.id, bob, "write", ada);
    expect(accessLevel(connection, project.id, bob)).toBe("write");
    expect(listGrants(connection, project.id)).toHaveLength(2);
  });

  it("takes access away, and says so when there was none", async () => {
    const connection = await database();
    const ada = await account(connection, "ada");
    const bob = await account(connection, "bob");
    const project = createProject(connection, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada,
    });

    expect(revokeAccess(connection, project.id, bob)).toBe(false);
    grantAccess(connection, project.id, bob, "read", ada);
    expect(revokeAccess(connection, project.id, bob)).toBe(true);
    expect(accessLevel(connection, project.id, bob)).toBeUndefined();
  });

  it("will not move an owner's grant, in either direction", async () => {
    const connection = await database();
    const ada = await account(connection, "ada");
    const project = createProject(connection, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada,
    });

    expect(() => grantAccess(connection, project.id, ada, "read", ada)).toThrow(OwnerGrantError);
    expect(() => revokeAccess(connection, project.id, ada)).toThrow(OwnerGrantError);
    expect(accessLevel(connection, project.id, ada)).toBe("owner");
  });

  it("lists what each account can reach, and the two lists differ", async () => {
    const connection = await database();
    const ada = await account(connection, "ada");
    const bob = await account(connection, "bob");
    const hers = createProject(connection, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada,
    });
    const his = createProject(connection, { id: newProjectId(), name: "lighthouse", createdBy: bob });
    grantAccess(connection, his.id, ada, "read", bob);

    expect(listProjectsFor(connection, ada).map((entry) => [entry.project.name, entry.level])).toEqual(
      [
        ["harbour", "owner"],
        ["lighthouse", "read"],
      ],
    );
    expect(listProjectsFor(connection, bob).map((entry) => [entry.project.name, entry.level])).toEqual(
      [["lighthouse", "owner"]],
    );
  });

  it("orders the levels, and names verbs for each", () => {
    expect(levelAllows("owner", "write")).toBe(true);
    expect(levelAllows("write", "write")).toBe(true);
    expect(levelAllows("read", "write")).toBe(false);
    expect(permissionsFor("read")).toEqual(["read"]);
    expect(permissionsFor("write")).toEqual(["read", "write"]);
  });
});

describe("forgetProject", () => {
  it("takes the grants with it", async () => {
    const connection = await database();
    const ada = await account(connection, "ada");
    const bob = await account(connection, "bob");
    const project = createProject(connection, {
      id: newProjectId(),
      name: "harbour",
      createdBy: ada,
    });
    grantAccess(connection, project.id, bob, "read", ada);

    expect(forgetProject(connection, project.id)).toBe(true);

    expect(listProjects(connection)).toEqual([]);
    expect(listProjectsFor(connection, bob)).toEqual([]);
    expect(forgetProject(connection, project.id)).toBe(false);
  });
});
