/**
 * The settings a Team server keeps in its database rather than in its source.
 *
 * There are two, both token lifetimes, and both are read where a token is
 * minted rather than held from the moment the process started. A Team server that read
 * them once would go on issuing month-long tokens after somebody shortened the
 * setting, and the only way to discover that would be to restart it and watch.
 *
 * A setting nobody has chosen has no row here, and the default in ./config.ts
 * answers for it. The comment on migration 3 in ./database.ts says why nothing
 * writes those defaults in.
 */
import type { DatabaseSync } from "node:sqlite";

import { DEFAULT_IDENTITY, type IdentityConfig } from "./config.js";
import { textColumn } from "./database.js";

/**
 * The two lifetimes, under the names the identity settings already give them.
 *
 * The same names on both sides mean one can be spread over the other, so that
 * "the stored value, unless the command line named one" is a line of code
 * rather than a translation table nobody remembers to extend.
 */
export type TokenLifetimes = Pick<
  IdentityConfig,
  "signInTokenLifetimeSeconds" | "repositoryTokenLifetimeSeconds"
>;

/** The key the sign-in token's lifetime is stored under. */
export const SIGN_IN_LIFETIME_KEY = "token.sign_in_lifetime_seconds";

/** The key the repository token's lifetime is stored under. */
export const REPOSITORY_LIFETIME_KEY = "token.repository_lifetime_seconds";

/**
 * Every key a person may name, in the order they are shown.
 *
 * The keys are the ones the table stores rather than shorter names invented for
 * the command line. A second set of names would have to be mapped onto these,
 * and the mapping would be the thing that says one name and writes another.
 */
export const SETTING_KEYS = [SIGN_IN_LIFETIME_KEY, REPOSITORY_LIFETIME_KEY] as const;

/** One of the keys above. */
export type SettingKey = (typeof SETTING_KEYS)[number];

/** True when `key` is a setting this Team server has. */
export function isSettingKey(key: string): key is SettingKey {
  return SETTING_KEYS.some((known) => known === key);
}

/**
 * The one thing about the repository lifetime that is not obvious from its
 * name, said in one sentence wherever it is being changed.
 *
 * Here rather than beside either surface, because both the command and the
 * terminal interface say it and two copies would drift.
 */
export const REPOSITORY_LIFETIME_CAUTION =
  "loreserver accepts this one without asking Team, so revoking access cannot cut it short.";

/**
 * The range a stored lifetime has to fall in.
 *
 * The floor is a minute so that a lifetime stays longer than the exchange that
 * issues the token: one that has expired before its holder can present it is
 * refused as an expired token, which reads as a clock that is wrong rather
 * than as a setting that is. The ceiling is a year because a repository token
 * is bounded by its expiry and by nothing else, and a bound that far out is
 * not a bound. Neither number is a limit of the format.
 */
export const MINIMUM_TOKEN_LIFETIME_SECONDS = 60;

/** The longest a stored lifetime may be; see the floor above for why. */
export const MAXIMUM_TOKEN_LIFETIME_SECONDS = 365 * 24 * 60 * 60;

/** Raised when a setting is not a value Team can use. */
export class InvalidSettingError extends Error {
  constructor(
    readonly key: string,
    readonly value: string,
  ) {
    super(
      `${key} cannot be "${value}". A token lifetime is a whole number of seconds, at ` +
        `least ${MINIMUM_TOKEN_LIFETIME_SECONDS} and at most ${MAXIMUM_TOKEN_LIFETIME_SECONDS}.`,
    );
    this.name = "InvalidSettingError";
  }
}

/** Whether a number of seconds is one a lifetime may be set to. */
function withinRange(seconds: number): boolean {
  return (
    Number.isSafeInteger(seconds) &&
    seconds >= MINIMUM_TOKEN_LIFETIME_SECONDS &&
    seconds <= MAXIMUM_TOKEN_LIFETIME_SECONDS
  );
}

/** The stored text of one setting, or undefined when there is no row. */
function readSetting(database: DatabaseSync, key: string): string | undefined {
  const row = database.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row === undefined ? undefined : textColumn(row, "value");
}

/**
 * One stored lifetime as a number, or `fallback` when nobody has set it.
 *
 * The value is checked here as well as on the way in. Validating on write
 * cannot be the whole of it: the file is SQLite and whoever has the storage
 * root can write to it with anything, and a lifetime that came back as NaN
 * would reach a token's `exp` and put it at the epoch — a token issued already
 * expired, from a Team server that says nothing is wrong.
 */
function lifetimeOf(database: DatabaseSync, key: string, fallback: number): number {
  const stored = readSetting(database, key);
  if (stored === undefined) {
    return fallback;
  }
  // Digits and nothing else: `Number` reads "1e9", " 60" and "0x10" as numbers,
  // and none of the three is what somebody meant to store.
  if (!/^\d+$/.test(stored) || !withinRange(Number(stored))) {
    throw new InvalidSettingError(key, stored);
  }
  return Number(stored);
}

/** True when somebody has stored a value for `key`, rather than left the default. */
export function isSettingStored(database: DatabaseSync, key: SettingKey): boolean {
  return readSetting(database, key) !== undefined;
}

/** The two lifetimes as they stand: stored where set, default where not. */
export function storedTokenLifetimes(database: DatabaseSync): TokenLifetimes {
  return {
    signInTokenLifetimeSeconds: lifetimeOf(
      database,
      SIGN_IN_LIFETIME_KEY,
      DEFAULT_IDENTITY.signInTokenLifetimeSeconds,
    ),
    repositoryTokenLifetimeSeconds: lifetimeOf(
      database,
      REPOSITORY_LIFETIME_KEY,
      DEFAULT_IDENTITY.repositoryTokenLifetimeSeconds,
    ),
  };
}

/**
 * Store one lifetime or both, and answer with the pair as it now stands.
 *
 * Everything named is checked before anything is written, so a call carrying
 * one good value and one bad leaves neither behind rather than half of it.
 */
export function setTokenLifetimes(
  database: DatabaseSync,
  values: Partial<TokenLifetimes>,
): TokenLifetimes {
  const writes: (readonly [string, number])[] = [];
  if (values.signInTokenLifetimeSeconds !== undefined) {
    writes.push([SIGN_IN_LIFETIME_KEY, values.signInTokenLifetimeSeconds]);
  }
  if (values.repositoryTokenLifetimeSeconds !== undefined) {
    writes.push([REPOSITORY_LIFETIME_KEY, values.repositoryTokenLifetimeSeconds]);
  }
  for (const [key, seconds] of writes) {
    if (!withinRange(seconds)) {
      throw new InvalidSettingError(key, String(seconds));
    }
  }

  const write = database.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const now = Date.now();
  for (const [key, seconds] of writes) {
    write.run(key, String(seconds), now);
  }

  return storedTokenLifetimes(database);
}

/**
 * One lifetime out of the pair, by the key it is stored under.
 *
 * The pair is what everything else here passes around, and a caller working
 * from a key — a command line, or a row on a screen — would otherwise have to
 * write out the same two-way choice each time it needed the value back.
 */
export function lifetimeUnder(lifetimes: TokenLifetimes, key: SettingKey): number {
  return key === SIGN_IN_LIFETIME_KEY
    ? lifetimes.signInTokenLifetimeSeconds
    : lifetimes.repositoryTokenLifetimeSeconds;
}

/** Store one lifetime by its key, and answer with the pair as it now stands. */
export function setTokenLifetime(
  database: DatabaseSync,
  key: SettingKey,
  seconds: number,
): TokenLifetimes {
  return setTokenLifetimes(
    database,
    key === SIGN_IN_LIFETIME_KEY
      ? { signInTokenLifetimeSeconds: seconds }
      : { repositoryTokenLifetimeSeconds: seconds },
  );
}

/**
 * The lifetimes out of what a command line named, and nothing else.
 *
 * What an operator writes wins over what is stored, for as long as that
 * command runs: `--token-lifetime` is written for one invocation, and a stored
 * setting it could not beat would leave the option doing nothing the moment
 * somebody set one.
 */
export function namedTokenLifetimes(overrides: Partial<IdentityConfig>): Partial<TokenLifetimes> {
  return {
    ...(overrides.signInTokenLifetimeSeconds === undefined
      ? {}
      : { signInTokenLifetimeSeconds: overrides.signInTokenLifetimeSeconds }),
    ...(overrides.repositoryTokenLifetimeSeconds === undefined
      ? {}
      : { repositoryTokenLifetimeSeconds: overrides.repositoryTokenLifetimeSeconds }),
  };
}
