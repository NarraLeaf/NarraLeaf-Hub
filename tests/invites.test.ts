import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { openMigratedDatabase } from "../src/identity/database.js";
import {
  createInvite,
  generateCode,
  InviteAlreadyUsedError,
  InviteExpiredError,
  listInvites,
  normaliseCode,
  redeemInvite,
  UnknownInviteError,
  withdrawUnusedBootstrapInvites,
} from "../src/identity/invites.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { countUsers, UsernameTakenError } from "../src/identity/users.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlhub-invites-");

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

describe("generateCode", () => {
  it("makes codes out of characters that are not misread for one another", () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      // Crockford's alphabet: no I, L, O or U anywhere in a generated code.
      expect(generateCode()).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}(-[0-9A-HJKMNP-TV-Z]{8}){3}$/);
    }
  });

  it("does not repeat itself", () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateCode()));

    expect(codes.size).toBe(50);
  });
});

describe("normaliseCode", () => {
  it("forgives the decoration and the characters people mistype", () => {
    const code = generateCode();

    expect(normaliseCode(code.toLowerCase())).toBe(normaliseCode(code));
    expect(normaliseCode(code.replaceAll("-", " "))).toBe(normaliseCode(code));
    // The letters Crockford leaves out fold onto the digits they are read as.
    expect(normaliseCode("l0Io")).toBe("1010");
  });
});

describe("createInvite", () => {
  it("hands the code back once and stores only its hash", async () => {
    const connection = await database();

    const { code, invite } = createInvite(connection, { role: "authors" });

    expect(invite.role).toBe("authors");
    expect(invite.usedAt).toBeUndefined();
    expect(invite.codeHash).toMatch(/^[0-9a-f]{64}$/);
    // Nothing in the stored record is the code, in any casing or spelling.
    const stored = JSON.stringify(listInvites(connection));
    expect(stored).not.toContain(code);
    expect(stored).not.toContain(normaliseCode(code));
  });
});

describe("redeemInvite", () => {
  it("makes an account, in the group the invite grants", async () => {
    const connection = await database();
    const { code } = createInvite(connection, { role: "admin" });

    const { user, invite } = await redeemInvite(connection, hasher, code, {
      username: "ada",
      password: PASSWORD,
    });

    expect(user.username).toBe("ada");
    expect(user.groups).toEqual(["admin"]);
    expect(invite.usedAt).toBeTypeOf("number");
    expect(invite.usedBy).toBe(user.id);
  });

  it("accepts a code typed back in lower case, with the dashes left out", async () => {
    const connection = await database();
    const { code } = createInvite(connection);

    const { user } = await redeemInvite(connection, hasher, code.replaceAll("-", "").toLowerCase(), {
      username: "ada",
      password: PASSWORD,
    });

    expect(user.username).toBe("ada");
  });

  it("works exactly once", async () => {
    const connection = await database();
    const { code } = createInvite(connection);
    await redeemInvite(connection, hasher, code, { username: "ada", password: PASSWORD });

    await expect(
      redeemInvite(connection, hasher, code, { username: "grace", password: PASSWORD }),
    ).rejects.toBeInstanceOf(InviteAlreadyUsedError);
    expect(countUsers(connection)).toBe(1);
  });

  it("leaves the invite unused when the account could not be made", async () => {
    const connection = await database();
    const first = createInvite(connection);
    const second = createInvite(connection);
    await redeemInvite(connection, hasher, first.code, { username: "ada", password: PASSWORD });

    await expect(
      redeemInvite(connection, hasher, second.code, { username: "ada", password: PASSWORD }),
    ).rejects.toBeInstanceOf(UsernameTakenError);

    // The account and the invite are written in one transaction, so a failed
    // account does not burn a code.
    const { user } = await redeemInvite(connection, hasher, second.code, {
      username: "grace",
      password: PASSWORD,
    });
    expect(user.username).toBe("grace");
  });

  it("refuses a code nobody issued, without saying anything else about it", async () => {
    const connection = await database();
    createInvite(connection);

    await expect(
      redeemInvite(connection, hasher, generateCode(), {
        username: "ada",
        password: PASSWORD,
      }),
    ).rejects.toBeInstanceOf(UnknownInviteError);
    expect(countUsers(connection)).toBe(0);
  });

  it("refuses a code that has expired", async () => {
    const connection = await database();
    const { code } = createInvite(connection, { lifetimeMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(
      redeemInvite(connection, hasher, code, { username: "ada", password: PASSWORD }),
    ).rejects.toBeInstanceOf(InviteExpiredError);
  });
});

describe("withdrawUnusedBootstrapInvites", () => {
  it("drops the unused ones and keeps everything else", async () => {
    const connection = await database();
    createInvite(connection, { isBootstrap: true });
    const used = createInvite(connection, { isBootstrap: true });
    createInvite(connection, { role: "authors" });
    await redeemInvite(connection, hasher, used.code, { username: "ada", password: PASSWORD });

    expect(withdrawUnusedBootstrapInvites(connection)).toBe(1);

    const left = listInvites(connection);
    expect(left).toHaveLength(2);
    expect(left.filter((invite) => invite.isBootstrap && invite.usedAt === undefined)).toEqual([]);
  });
});
