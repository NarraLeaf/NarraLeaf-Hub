import { describe, expect, it } from "vitest";

import { parseArgs } from "../src/args.js";
import { DEFAULT_PORTS } from "../src/loreserver/layout.js";

/** The error message from a command line that was not understood. */
function messageFor(argv: readonly string[]): string {
  const result = parseArgs(argv);
  expect(result.kind).toBe("error");
  return result.kind === "error" ? result.message : "";
}

describe("parseArgs", () => {
  it("recognises the long and short spellings of --version", () => {
    expect(parseArgs(["--version"])).toEqual({ kind: "version" });
    expect(parseArgs(["-v"])).toEqual({ kind: "version" });
  });

  it("recognises the long and short spellings of --help", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["-h"])).toEqual({ kind: "help" });
  });

  it("treats an empty command line as a request for help", () => {
    expect(parseArgs([])).toEqual({ kind: "help" });
  });

  it("reports an unknown argument and names it", () => {
    const result = parseArgs(["--nonsense"]);

    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.message).toContain("--nonsense");
  });

  it("rejects a trailing argument that no option or command can consume", () => {
    const result = parseArgs(["--version", "stray"]);

    expect(result.kind).toBe("error");
    expect(result.kind === "error" && result.message).toContain("stray");
  });

  it("calls a word that is not a command a command", () => {
    expect(messageFor(["dance"])).toBe("unknown command: dance");
  });
});

describe("parseArgs, up", () => {
  it("takes a root and fills in the default ports", () => {
    expect(parseArgs(["up", "--root", "/srv/hub"])).toEqual({
      kind: "up",
      root: "/srv/hub",
      dataPort: DEFAULT_PORTS.dataPort,
      healthPort: DEFAULT_PORTS.healthPort,
      // Identity is off unless it is asked for: a loreserver that suddenly
      // demanded a token would lock out every client an operator already has.
      identity: false,
      overrides: {},
    });
  });

  it("switches identity on, and carries the settings that go with it", () => {
    expect(
      parseArgs([
        "up",
        "--root",
        "/srv/hub",
        "--identity",
        "--issuer",
        "hub.example.com",
        "--audience",
        "lore",
        "--auth-origin",
        "hub.example.com",
        "--hub-port",
        "41500",
        "--token-lifetime",
        "5m",
      ]),
    ).toMatchObject({
      identity: true,
      overrides: {
        issuer: "hub.example.com",
        audience: "lore",
        authOrigin: "hub.example.com",
        hubPort: 41500,
        signInTokenLifetimeSeconds: 300,
      },
    });
  });

  it("refuses an auth origin written as a URL, which would be doubled", () => {
    expect(messageFor(["up", "--root", "/srv/hub", "--auth-origin", "https://hub.example.com"]))
      .toContain("without a scheme");
  });

  it("accepts ports on the command line", () => {
    expect(parseArgs(["up", "--root", "/srv/hub", "--data-port", "9000"])).toMatchObject({
      dataPort: 9000,
      healthPort: DEFAULT_PORTS.healthPort,
    });
    expect(parseArgs(["up", "--root", "/srv/hub", "--health-port", "9001"])).toMatchObject({
      dataPort: DEFAULT_PORTS.dataPort,
      healthPort: 9001,
    });
  });

  it("accepts a value joined to its option with an equals sign", () => {
    expect(parseArgs(["up", "--root=/srv/hub", "--data-port=9000"])).toMatchObject({
      root: "/srv/hub",
      dataPort: 9000,
    });
  });

  it("keeps a Windows path intact, backslashes and all", () => {
    expect(parseArgs(["up", "--root", "D:\\srv\\hub"])).toMatchObject({ root: "D:\\srv\\hub" });
  });

  it("insists on a root, because there is no sensible default for one", () => {
    expect(messageFor(["up"])).toContain("--root");
    expect(messageFor(["up", "--data-port", "9000"])).toContain("--root");
  });

  it("rejects a port that is not one", () => {
    expect(messageFor(["up", "--root", "/srv/hub", "--data-port", "http"])).toContain(
      "needs a port number",
    );
    expect(messageFor(["up", "--root", "/srv/hub", "--data-port", "0"])).toContain("between 1");
    expect(messageFor(["up", "--root", "/srv/hub", "--data-port", "70000"])).toContain(
      "between 1",
    );
    expect(messageFor(["up", "--root", "/srv/hub", "--health-port", "1.5"])).toContain(
      "needs a port number",
    );
  });

  it("rejects one port doing both jobs", () => {
    // gRPC and QUIC share a number because they are on different transports.
    // The health check is HTTP, on the same transport as gRPC.
    expect(
      messageFor(["up", "--root", "/srv/hub", "--data-port", "9000", "--health-port", "9000"]),
    ).toContain("cannot both be 9000");
    // Four listeners come up on one machine, so the check covers Hub's two as
    // well: whichever lost the race would be silently absent.
    expect(
      messageFor(["up", "--root", "/srv/hub", "--hub-port", "9000", "--auth-port", "9000"]),
    ).toContain("cannot both be 9000");
    expect(
      messageFor(["up", "--root", "/srv/hub", "--auth-port", String(DEFAULT_PORTS.dataPort)]),
    ).toContain("cannot both be");
  });

  it("reports an option with nothing after it", () => {
    expect(messageFor(["up", "--root"])).toContain("--root needs a value");
  });

  it("reports an option it does not have", () => {
    expect(messageFor(["up", "--root", "/srv/hub", "--verbose"])).toContain("--verbose");
  });

  it("answers --help after the command with help", () => {
    expect(parseArgs(["up", "--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["up", "--root", "/srv/hub", "-h"])).toEqual({ kind: "help" });
  });
});

describe("parseArgs, the identity commands", () => {
  it("makes an invite with a default role and expiry", () => {
    expect(parseArgs(["invite", "create", "--root", "/srv/hub"])).toEqual({
      kind: "invite-create",
      root: "/srv/hub",
      role: "member",
      lifetimeMs: 7 * 24 * 60 * 60 * 1000,
    });
  });

  it("reads a duration in the units people write them in", () => {
    expect(parseArgs(["invite", "create", "--root", "/srv/hub", "--expires", "48h"])).toMatchObject(
      { lifetimeMs: 48 * 60 * 60 * 1000 },
    );
    expect(parseArgs(["invite", "create", "--root", "/srv/hub", "--expires", "90"])).toMatchObject({
      lifetimeMs: 90 * 1000,
    });
    expect(messageFor(["invite", "create", "--root", "/srv/hub", "--expires", "soon"])).toContain(
      "duration",
    );
  });

  it("takes a username as the word after the verb", () => {
    expect(parseArgs(["user", "disable", "ada", "--root", "/srv/hub"])).toEqual({
      kind: "user-disable",
      root: "/srv/hub",
      username: "ada",
    });
    expect(parseArgs(["user", "enable", "--root", "/srv/hub", "ada"])).toEqual({
      kind: "user-enable",
      root: "/srv/hub",
      username: "ada",
    });
    expect(parseArgs(["user", "revoke-tokens", "ada", "--root", "/srv/hub"])).toEqual({
      kind: "user-revoke-tokens",
      root: "/srv/hub",
      username: "ada",
    });
    expect(messageFor(["user", "disable", "--root", "/srv/hub"])).toContain("needs a username");
    expect(messageFor(["user", "revoke-tokens", "--root", "/srv/hub"])).toContain(
      "needs a username",
    );
  });

  it("insists that an account comes from an invitation", () => {
    expect(
      parseArgs(["user", "create", "ada", "--root", "/srv/hub", "--invite", "CODE"]),
    ).toEqual({
      kind: "user-create",
      root: "/srv/hub",
      username: "ada",
      code: "CODE",
      displayName: undefined,
      email: undefined,
      isServiceAccount: false,
    });
    expect(messageFor(["user", "create", "ada", "--root", "/srv/hub"])).toContain("--invite");
  });

  it("marks a service account when it is told to", () => {
    expect(
      parseArgs([
        "user",
        "create",
        "builder",
        "--root",
        "/srv/hub",
        "--invite",
        "CODE",
        "--service-account",
        "--display-name",
        "Build robot",
      ]),
    ).toMatchObject({ isServiceAccount: true, displayName: "Build robot" });
  });

  it("mints for one named account, with the identity settings it is given", () => {
    expect(
      parseArgs(["token", "mint", "ada", "--root", "/srv/hub", "--env", "staging"]),
    ).toEqual({
      kind: "token-mint",
      root: "/srv/hub",
      username: "ada",
      overrides: { env: "staging" },
    });
  });

  it("rotates and lists keys", () => {
    expect(parseArgs(["key", "rotate", "--root", "/srv/hub"])).toEqual({
      kind: "key-rotate",
      root: "/srv/hub",
    });
    expect(parseArgs(["key", "list", "--root", "/srv/hub"])).toEqual({
      kind: "key-list",
      root: "/srv/hub",
    });
  });

  it("names the verb it did not recognise, and the ones it has", () => {
    expect(messageFor(["user", "invent", "--root", "/srv/hub"])).toBe("unknown user command: invent");
    expect(messageFor(["user"])).toContain("list, create, disable, enable or revoke-tokens");
    expect(messageFor(["key", "melt", "--root", "/srv/hub"])).toBe("unknown key command: melt");
  });

  it("wants a root for every command that keeps state", () => {
    for (const argv of [
      ["invite", "create"],
      ["user", "list"],
      ["user", "disable", "ada"],
      ["user", "revoke-tokens", "ada"],
      ["token", "mint", "ada"],
      ["project", "list"],
      ["project", "create", "harbour"],
      ["key", "rotate"],
    ]) {
      expect(messageFor(argv)).toContain("--root");
    }
  });
});

describe("parseArgs, the project commands", () => {
  it("creates a project, with the default loreserver port and no owner named", () => {
    expect(parseArgs(["project", "create", "harbour", "--root", "/srv/hub"])).toEqual({
      kind: "project-create",
      root: "/srv/hub",
      name: "harbour",
      description: undefined,
      // Absent means the account is worked out from the Hub, which only has an
      // answer when there is exactly one.
      as: undefined,
      dataPort: DEFAULT_PORTS.dataPort,
      overrides: {},
    });
  });

  it("takes a description, an owner, a port and the identity settings", () => {
    expect(
      parseArgs([
        "project",
        "create",
        "harbour",
        "--root",
        "/srv/hub",
        "--description",
        "a game about a port at night",
        "--as",
        "ada",
        "--data-port",
        "9000",
        "--issuer",
        "hub.example.com",
      ]),
    ).toMatchObject({
      description: "a game about a port at night",
      as: "ada",
      dataPort: 9000,
      overrides: { issuer: "hub.example.com" },
    });
  });

  it("lists everything, or what one account can reach", () => {
    expect(parseArgs(["project", "list", "--root", "/srv/hub"])).toEqual({
      kind: "project-list",
      root: "/srv/hub",
      as: undefined,
    });
    expect(parseArgs(["project", "list", "--root", "/srv/hub", "--as", "ada"])).toMatchObject({
      as: "ada",
    });
  });

  it("grants read unless another level is named, and revokes", () => {
    expect(parseArgs(["project", "grant", "harbour", "ada", "--root", "/srv/hub"])).toEqual({
      kind: "project-grant",
      root: "/srv/hub",
      project: "harbour",
      username: "ada",
      level: "read",
    });
    expect(
      parseArgs(["project", "grant", "harbour", "ada", "--root", "/srv/hub", "--level", "write"]),
    ).toMatchObject({ level: "write" });
    expect(parseArgs(["project", "revoke", "harbour", "ada", "--root", "/srv/hub"])).toEqual({
      kind: "project-revoke",
      root: "/srv/hub",
      project: "harbour",
      username: "ada",
    });
  });

  it("refuses a level that is not one of the two that can be given", () => {
    // Ownership comes from creating a project, so it is not something --level
    // hands out.
    expect(
      messageFor(["project", "grant", "harbour", "ada", "--root", "/srv/hub", "--level", "owner"]),
    ).toContain("read or write");
  });

  it("says what is missing, and names the verb it did not recognise", () => {
    expect(messageFor(["project", "create", "--root", "/srv/hub"])).toContain("needs a name");
    expect(messageFor(["project", "grant", "harbour", "--root", "/srv/hub"])).toContain(
      "a project and a username",
    );
    expect(messageFor(["project", "invent"])).toBe("unknown project command: invent");
    expect(messageFor(["project"])).toContain("create, list, grant or revoke");
  });
});
