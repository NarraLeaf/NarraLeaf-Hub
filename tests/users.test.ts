import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { openMigratedDatabase } from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import {
  authenticate,
  countUsers,
  createUser,
  disableUser,
  enableUser,
  findUser,
  InvalidUsernameError,
  listUsers,
  UnknownUserError,
  UsernameTakenError,
  WeakPasswordError,
} from "../src/identity/users.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlhub-users-");

/** Cheap parameters: these tests are about the records, not the cost. */
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);

const PASSWORD = "a password nobody guesses";

const open: DatabaseSync[] = [];

async function database(): Promise<DatabaseSync> {
  const connection = await openMigratedDatabase(identityLayout(await temporaryRoot()).databasePath);
  open.push(connection);
  return connection;
}

afterEach(() => {
  while (open.length > 0) {
    open.pop()?.close();
  }
});

describe("createUser", () => {
  it("records an account and puts it in the groups it was given", async () => {
    const connection = await database();

    const user = await createUser(connection, hasher, {
      username: "Ada",
      password: PASSWORD,
      displayName: "Ada Lovelace",
      email: "ada@example.com",
      groups: ["admin", "admin", "authors"],
    });

    // The name is folded, so that Ada and ada cannot become two accounts that
    // read as one person.
    expect(user.username).toBe("ada");
    expect(user.displayName).toBe("Ada Lovelace");
    expect(user.email).toBe("ada@example.com");
    expect(user.isServiceAccount).toBe(false);
    expect(user.disabledAt).toBeUndefined();
    expect(user.tokenEpoch).toBe(1);
    expect(user.groups).toEqual(["admin", "authors"]);
    expect(countUsers(connection)).toBe(1);
  });

  it("refuses a second account with the same name", async () => {
    const connection = await database();
    await createUser(connection, hasher, { username: "ada", password: PASSWORD });

    await expect(
      createUser(connection, hasher, { username: "ADA", password: PASSWORD }),
    ).rejects.toBeInstanceOf(UsernameTakenError);
    expect(countUsers(connection)).toBe(1);
  });

  it("refuses a name that is not one, and a password too short to bother with", async () => {
    const connection = await database();

    await expect(
      createUser(connection, hasher, { username: "a b", password: PASSWORD }),
    ).rejects.toBeInstanceOf(InvalidUsernameError);
    await expect(
      createUser(connection, hasher, { username: "ada", password: "short" }),
    ).rejects.toBeInstanceOf(WeakPasswordError);
    expect(countUsers(connection)).toBe(0);
  });

  it("keeps no password hash on the record it hands back", async () => {
    const connection = await database();
    const user = await createUser(connection, hasher, { username: "ada", password: PASSWORD });

    // Whatever a caller does with a user record — log it, print it, serialise
    // it — the hash is not in it to leak.
    expect(JSON.stringify(user)).not.toContain("scrypt");
  });
});

describe("listUsers", () => {
  it("lists every account in name order", async () => {
    const connection = await database();
    await createUser(connection, hasher, { username: "zoe", password: PASSWORD });
    await createUser(connection, hasher, { username: "ada", password: PASSWORD });

    expect(listUsers(connection).map((user) => user.username)).toEqual(["ada", "zoe"]);
  });
});

describe("disableUser and enableUser", () => {
  it("marks the account and bumps the epoch that makes tokens unrenewable", async () => {
    const connection = await database();
    await createUser(connection, hasher, { username: "ada", password: PASSWORD });

    const disabled = disableUser(connection, "ada");

    expect(disabled.disabledAt).toBeTypeOf("number");
    expect(disabled.tokenEpoch).toBe(2);
  });

  it("does not put the epoch back when the account is enabled again", async () => {
    const connection = await database();
    await createUser(connection, hasher, { username: "ada", password: PASSWORD });
    disableUser(connection, "ada");

    const enabled = enableUser(connection, "ada");

    expect(enabled.disabledAt).toBeUndefined();
    // Tokens minted before the account was disabled stay unrenewable: whatever
    // made disabling worth doing has not become untrue.
    expect(enabled.tokenEpoch).toBe(2);
  });

  it("names an account that is not there rather than doing nothing", async () => {
    const connection = await database();

    expect(() => disableUser(connection, "nobody")).toThrow(UnknownUserError);
  });
});

describe("authenticate", () => {
  it("signs in with the right password", async () => {
    const connection = await database();
    await createUser(connection, hasher, { username: "ada", password: PASSWORD });

    const result = await authenticate(connection, hasher, "Ada", PASSWORD);

    expect(result.kind).toBe("signed-in");
    expect(result.kind === "signed-in" && result.user.username).toBe("ada");
  });

  it("tells the caller apart the ways it can fail, in one shape", async () => {
    const connection = await database();
    await createUser(connection, hasher, { username: "ada", password: PASSWORD });

    await expect(authenticate(connection, hasher, "ada", "wrong")).resolves.toEqual({
      kind: "refused",
      reason: "wrong-password",
    });
    await expect(authenticate(connection, hasher, "nobody", PASSWORD)).resolves.toEqual({
      kind: "refused",
      reason: "no-such-user",
    });

    disableUser(connection, "ada");
    await expect(authenticate(connection, hasher, "ada", PASSWORD)).resolves.toEqual({
      kind: "refused",
      reason: "disabled",
    });
  });

  it("refuses a stored hash it cannot read, without raising into the caller", async () => {
    const connection = await database();
    const user = await createUser(connection, hasher, { username: "ada", password: PASSWORD });
    connection
      .prepare("UPDATE users SET password_hash = ? WHERE id = ?")
      .run("argon2id$m=65536,t=3,p=4$c2FsdA==$aGFzaA==", user.id);

    await expect(authenticate(connection, hasher, "ada", PASSWORD)).resolves.toEqual({
      kind: "refused",
      reason: "unreadable-password-hash",
    });
  });

  it("replaces a hash made with superseded parameters, on the way through", async () => {
    const connection = await database();
    await createUser(connection, hasher, { username: "ada", password: PASSWORD });
    const stored = (): string => {
      const row = connection.prepare("SELECT password_hash AS hash FROM users").get();
      return String(row?.["hash"]);
    };
    const before = stored();
    expect(before).toContain(`N=${CHEAP.cost}`);

    const raised = new ScryptPasswordHasher({ ...CHEAP, cost: CHEAP.cost * 4 });
    const result = await authenticate(connection, raised, "ada", PASSWORD);

    expect(result.kind).toBe("signed-in");
    expect(stored()).toContain(`N=${CHEAP.cost * 4}`);
    // And the new one is a working hash of the same password.
    expect(await raised.verify(PASSWORD, stored())).toBe(true);
  });

  it("leaves the hash alone when the parameters have not moved", async () => {
    const connection = await database();
    await createUser(connection, hasher, { username: "ada", password: PASSWORD });
    const before = findUser(connection, "ada");
    const row = connection.prepare("SELECT password_hash AS hash FROM users").get();

    await authenticate(connection, hasher, "ada", PASSWORD);

    expect(connection.prepare("SELECT password_hash AS hash FROM users").get()).toEqual(row);
    expect(before?.tokenEpoch).toBe(1);
  });
});
