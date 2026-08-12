import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_IDENTITY } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import {
  InvalidSettingError,
  MAXIMUM_TOKEN_LIFETIME_SECONDS,
  MINIMUM_TOKEN_LIFETIME_SECONDS,
  namedTokenLifetimes,
  REPOSITORY_LIFETIME_KEY,
  setTokenLifetimes,
  SIGN_IN_LIFETIME_KEY,
  storedTokenLifetimes,
} from "../src/identity/settings.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlhub-settings-");

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

/** Put a value in the table directly, the way an operator with the file could. */
function store(connection: DatabaseSync, key: string, value: string): void {
  connection
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .run(key, value, Date.now());
}

describe("storedTokenLifetimes", () => {
  it("answers with the defaults on a Hub where nobody has stored anything", async () => {
    const connection = await database();

    expect(storedTokenLifetimes(connection)).toEqual({
      signInTokenLifetimeSeconds: DEFAULT_IDENTITY.signInTokenLifetimeSeconds,
      repositoryTokenLifetimeSeconds: DEFAULT_IDENTITY.repositoryTokenLifetimeSeconds,
    });
    // The two numbers themselves, because the asymmetry is the point: a token
    // Hub is asked about again can last a month, and one loreserver's data
    // plane checks for itself has nothing but its expiry to bound it.
    expect(DEFAULT_IDENTITY.signInTokenLifetimeSeconds).toBe(30 * 24 * 60 * 60);
    expect(DEFAULT_IDENTITY.repositoryTokenLifetimeSeconds).toBe(15 * 60);
  });

  it("reads back a value that has been stored, and leaves the other at its default", async () => {
    const connection = await database();

    setTokenLifetimes(connection, { signInTokenLifetimeSeconds: 7 * 24 * 60 * 60 });

    expect(storedTokenLifetimes(connection)).toEqual({
      signInTokenLifetimeSeconds: 7 * 24 * 60 * 60,
      repositoryTokenLifetimeSeconds: DEFAULT_IDENTITY.repositoryTokenLifetimeSeconds,
    });
  });

  it("replaces a value rather than making a second row for the same setting", async () => {
    const connection = await database();

    setTokenLifetimes(connection, { repositoryTokenLifetimeSeconds: 300 });
    setTokenLifetimes(connection, { repositoryTokenLifetimeSeconds: 600 });

    expect(storedTokenLifetimes(connection).repositoryTokenLifetimeSeconds).toBe(600);
    expect(connection.prepare("SELECT COUNT(*) AS count FROM settings").get()).toEqual({
      count: 1,
    });
  });

  it("refuses a stored value that is not a number of seconds", async () => {
    const connection = await database();
    // Nothing Hub writes could put this here. Whoever has the storage root has
    // the SQLite file, and a value read back as NaN would reach a token's `exp`
    // and issue it already expired, from a Hub saying nothing is wrong.
    store(connection, SIGN_IN_LIFETIME_KEY, "an hour or so");

    expect(() => storedTokenLifetimes(connection)).toThrow(InvalidSettingError);
  });

  it("refuses a stored number outside the range it would have accepted", async () => {
    const connection = await database();
    store(connection, REPOSITORY_LIFETIME_KEY, String(MINIMUM_TOKEN_LIFETIME_SECONDS - 1));

    expect(() => storedTokenLifetimes(connection)).toThrow(InvalidSettingError);
  });
});

describe("setTokenLifetimes", () => {
  it("refuses a lifetime shorter or longer than one Hub will store", async () => {
    const connection = await database();

    expect(() => setTokenLifetimes(connection, { signInTokenLifetimeSeconds: 0 })).toThrow(
      InvalidSettingError,
    );
    expect(() =>
      setTokenLifetimes(connection, {
        signInTokenLifetimeSeconds: MINIMUM_TOKEN_LIFETIME_SECONDS - 1,
      }),
    ).toThrow(InvalidSettingError);
    expect(() =>
      setTokenLifetimes(connection, {
        signInTokenLifetimeSeconds: MAXIMUM_TOKEN_LIFETIME_SECONDS + 1,
      }),
    ).toThrow(InvalidSettingError);
    expect(() => setTokenLifetimes(connection, { repositoryTokenLifetimeSeconds: 90.5 })).toThrow(
      InvalidSettingError,
    );
  });

  it("names the setting it would not take, not merely the number", async () => {
    const connection = await database();

    expect(() => setTokenLifetimes(connection, { repositoryTokenLifetimeSeconds: 1 })).toThrow(
      new RegExp(REPOSITORY_LIFETIME_KEY.replace(".", "\.")),
    );
  });

  it("writes neither when one of a pair is refused", async () => {
    const connection = await database();

    expect(() =>
      setTokenLifetimes(connection, {
        signInTokenLifetimeSeconds: 3600,
        repositoryTokenLifetimeSeconds: 1,
      }),
    ).toThrow(InvalidSettingError);

    // Half of a change is worse than none of one: an operator who saw the
    // failure would have no reason to go and look at the other setting.
    expect(storedTokenLifetimes(connection)).toEqual({
      signInTokenLifetimeSeconds: DEFAULT_IDENTITY.signInTokenLifetimeSeconds,
      repositoryTokenLifetimeSeconds: DEFAULT_IDENTITY.repositoryTokenLifetimeSeconds,
    });
  });

  it("hands back the pair as it stands after the write", async () => {
    const connection = await database();

    expect(setTokenLifetimes(connection, { repositoryTokenLifetimeSeconds: 120 })).toEqual({
      signInTokenLifetimeSeconds: DEFAULT_IDENTITY.signInTokenLifetimeSeconds,
      repositoryTokenLifetimeSeconds: 120,
    });
  });
});

describe("namedTokenLifetimes", () => {
  it("keeps the lifetimes a command line named and nothing else about it", () => {
    expect(namedTokenLifetimes({ signInTokenLifetimeSeconds: 300, issuer: "elsewhere" })).toEqual({
      signInTokenLifetimeSeconds: 300,
    });
  });

  it("is empty when a command line named neither", () => {
    // Which is what lets it be spread over the stored settings without hiding
    // them: an empty object changes nothing, and `undefined` values would.
    expect(namedTokenLifetimes({})).toEqual({});
  });
});
