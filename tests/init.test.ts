// The one command that makes an account without an operator already there:
// what it produces, and the moment it stops working.
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { openMigratedDatabase } from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import { defaultPasswordHasher } from "../src/identity/passwords.js";
import { authenticate, listUsers } from "../src/identity/users.js";
import { init } from "../src/init.js";
import { useTemporaryRoots } from "./temporary.js";

const PASSWORD = "correct horse battery";

const temporaryRoot = useTemporaryRoots("nlteam-init-");

// Replaced rather than written to, because readPassword reads process.stdin
// itself: a command that took a stream as an argument would be a command
// nobody runs the way it is tested.
const realStdin = Object.getOwnPropertyDescriptor(process, "stdin");

afterEach(() => {
  if (realStdin !== undefined) {
    Object.defineProperty(process, "stdin", realStdin);
  }
});

function pipeIn(text: string): void {
  const stream = Readable.from([Buffer.from(text, "utf8")]) as unknown as NodeJS.ReadStream;
  stream.isTTY = false;
  Object.defineProperty(process, "stdin", { value: stream, configurable: true });
}

async function runInit(
  root: string,
  username: string,
  password: string = PASSWORD,
): Promise<{ code: number; out: string; err: string }> {
  pipeIn(password);
  let out = "";
  let err = "";
  const code = await init(
    { root, username, displayName: undefined, email: undefined },
    (text) => {
      out += text;
    },
    (text) => {
      err += text;
    },
  );
  return { code, out, err };
}

/** Every account in the file, read back through a connection of its own. */
async function accounts(root: string): Promise<string[]> {
  const database = await openMigratedDatabase(identityLayout(root).databasePath);
  try {
    return listUsers(database).map((user) => user.username);
  } finally {
    database.close();
  }
}

describe("init", () => {
  it("makes the first account, in the group that can open the view", async () => {
    const root = await temporaryRoot();

    const { code, out, err } = await runInit(root, "ada");

    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toContain("created ada");
    expect(out).toContain("groups: admin");
    expect(await accounts(root)).toEqual(["ada"]);
  });

  it("stores a password the account can then sign in with", async () => {
    const root = await temporaryRoot();
    await runInit(root, "ada");

    const database = await openMigratedDatabase(identityLayout(root).databasePath);
    try {
      const hasher = defaultPasswordHasher();
      expect((await authenticate(database, hasher, "ada", PASSWORD)).kind).toBe("signed-in");
      // The one that would pass if the password were stored unchecked.
      expect((await authenticate(database, hasher, "ada", "something else")).kind).toBe("refused");
    } finally {
      database.close();
    }
  });

  it("refuses once there is somebody who could make the next account", async () => {
    const root = await temporaryRoot();
    await runInit(root, "ada");

    const { code, err } = await runInit(root, "mallory");

    expect(code).toBe(1);
    // The refusal names the way in that is left, because an operator who has
    // just been stopped is on their way to looking for one.
    expect(err).toContain("nlteam user create");
    expect(await accounts(root)).toEqual(["ada"]);
  });

  it("leaves nothing behind when the password is too short to store", async () => {
    const root = await temporaryRoot();

    const { code, err } = await runInit(root, "ada", "short");

    expect(code).toBe(1);
    expect(err).toContain("at least");
    expect(await accounts(root)).toEqual([]);
  });
});
