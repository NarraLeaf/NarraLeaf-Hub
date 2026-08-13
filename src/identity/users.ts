/**
 * The accounts Team issues tokens for.
 *
 * A user record carries no password hash. Reading one is a separate query,
 * made only by the code that is about to check a password, so that a record
 * which ends up in a log, a status line or a JSON reply cannot take the hash
 * with it.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  booleanColumn,
  integerColumn,
  optionalIntegerColumn,
  optionalTextColumn,
  textColumn,
  type Row,
} from "./database.js";
import { MalformedPasswordHashError, type PasswordHasher } from "./passwords.js";

/** One account. */
export interface UserRecord {
  /** Stable identifier; this is what a token's `sub` claim holds. */
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string | undefined;
  readonly isServiceAccount: boolean;
  /** Milliseconds since the epoch. */
  readonly createdAt: number;
  /** When the account was disabled, or undefined while it may sign in. */
  readonly disabledAt: number | undefined;
  /** Bumped to make outstanding tokens unrenewable; see ./tokens.ts. */
  readonly tokenEpoch: number;
  /**
   * When the epoch above was last bumped, or undefined for an account whose
   * tokens have never been refused.
   *
   * Undefined also on an account whose tokens were refused before Team kept this
   * moment: migration 4 leaves the column NULL for rows that already existed
   * rather than inventing a timestamp for a bump nobody recorded.
   */
  readonly tokensInvalidatedAt: number | undefined;
  readonly groups: readonly string[];
}

/** Raised when a username does not fit the rules. */
export class InvalidUsernameError extends Error {
  constructor(username: string) {
    super(
      `"${username}" cannot be a username. A username is 2 to 32 characters of ` +
        "a-z, 0-9, dot, dash and underscore, and starts with a letter or a digit.",
    );
    this.name = "InvalidUsernameError";
  }
}

/** Raised when a username is already in use. */
export class UsernameTakenError extends Error {
  constructor(readonly username: string) {
    super(`there is already an account called ${username}.`);
    this.name = "UsernameTakenError";
  }
}

/** Raised when no account goes by a name a command was given. */
export class UnknownUserError extends Error {
  constructor(readonly username: string) {
    super(`there is no account called ${username}.`);
    this.name = "UnknownUserError";
  }
}

/** Raised when a password is too short to be worth hashing. */
export class WeakPasswordError extends Error {
  constructor() {
    super(
      `a password must be at least ${MINIMUM_PASSWORD_LENGTH} characters. There are no ` +
        "rules about which characters: length is what makes a password hard to guess, " +
        "and composition rules mostly make people choose predictably.",
    );
    this.name = "WeakPasswordError";
  }
}

/** The shortest password Team will store. */
export const MINIMUM_PASSWORD_LENGTH = 10;

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,31}$/;

/**
 * Fold a username to the form it is stored and compared in.
 *
 * Case is removed rather than preserved, so that `Ada` and `ada` cannot become
 * two accounts that look like one person in every list they appear in.
 */
export function normaliseUsername(username: string): string {
  return username.trim().toLowerCase();
}

function groupsOf(database: DatabaseSync, userId: string): string[] {
  const rows = database
    .prepare("SELECT group_name FROM user_groups WHERE user_id = ? ORDER BY group_name")
    .all(userId);
  return rows.map((row) => textColumn(row, "group_name"));
}

function toUser(database: DatabaseSync, row: Row): UserRecord {
  const id = textColumn(row, "id");
  return {
    id,
    username: textColumn(row, "username"),
    displayName: textColumn(row, "display_name"),
    email: optionalTextColumn(row, "email"),
    isServiceAccount: booleanColumn(row, "is_service_account"),
    createdAt: integerColumn(row, "created_at"),
    disabledAt: optionalIntegerColumn(row, "disabled_at"),
    tokenEpoch: integerColumn(row, "token_epoch"),
    tokensInvalidatedAt: optionalIntegerColumn(row, "tokens_invalidated_at"),
    groups: groupsOf(database, id),
  };
}

const SELECT_USER =
  "SELECT id, username, display_name, email, is_service_account, created_at, " +
  "disabled_at, token_epoch, tokens_invalidated_at FROM users";

/** Every account, in name order. */
export function listUsers(database: DatabaseSync): UserRecord[] {
  return database
    .prepare(`${SELECT_USER} ORDER BY username`)
    .all()
    .map((row) => toUser(database, row));
}

/** How many accounts exist. Zero is what makes a Team server need bootstrapping. */
export function countUsers(database: DatabaseSync): number {
  const row = database.prepare("SELECT COUNT(*) AS count FROM users").get();
  return row === undefined ? 0 : integerColumn(row, "count");
}

/** The account with this name, or undefined. */
export function findUser(database: DatabaseSync, username: string): UserRecord | undefined {
  const row = database
    .prepare(`${SELECT_USER} WHERE username = ?`)
    .get(normaliseUsername(username));
  return row === undefined ? undefined : toUser(database, row);
}

/**
 * The account with this id, or undefined.
 *
 * The id is what a token's `sub` claim holds, so this is how a caller who
 * presented one is turned back into an account. It is separate from lookup by
 * name because a name can be typed and an id cannot: nothing normalises here.
 */
export function findUserById(database: DatabaseSync, id: string): UserRecord | undefined {
  const row = database.prepare(`${SELECT_USER} WHERE id = ?`).get(id);
  return row === undefined ? undefined : toUser(database, row);
}

/** The account with this name, or a failure naming it. */
export function requireUser(database: DatabaseSync, username: string): UserRecord {
  const user = findUser(database, username);
  if (user === undefined) {
    throw new UnknownUserError(username);
  }
  return user;
}

/** What a new account is made from. */
export interface NewUser {
  readonly username: string;
  readonly password: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly isServiceAccount?: boolean;
  /** Group names, which become the token's `groups` claim. */
  readonly groups?: readonly string[];
}

/** An account checked and hashed, ready to be written. */
export interface PreparedUser {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string | undefined;
  readonly passwordHash: string;
  readonly isServiceAccount: boolean;
  readonly createdAt: number;
  readonly groups: readonly string[];
}

/**
 * Check an account and hash its password, touching no database.
 *
 * Hashing takes a good fraction of a second by design, which is why it happens
 * before any transaction is open rather than inside one.
 */
export async function prepareUser(
  hasher: PasswordHasher,
  input: NewUser,
): Promise<PreparedUser> {
  const username = normaliseUsername(input.username);
  if (!USERNAME_PATTERN.test(username)) {
    throw new InvalidUsernameError(input.username);
  }
  if (input.password.length < MINIMUM_PASSWORD_LENGTH) {
    throw new WeakPasswordError();
  }

  return {
    id: randomUUID(),
    username,
    displayName: input.displayName ?? username,
    email: input.email,
    passwordHash: await hasher.hash(input.password),
    isServiceAccount: input.isServiceAccount === true,
    createdAt: Date.now(),
    groups: [...new Set(input.groups ?? [])].sort(),
  };
}

/**
 * Write a prepared account.
 *
 * No transaction is opened here, so that redeeming an invite can put this and
 * the marking of the invite inside one — an account created from an invite that
 * stayed unused would let one code make any number of accounts.
 */
export function insertUser(database: DatabaseSync, prepared: PreparedUser): void {
  try {
    database
      .prepare(
        `INSERT INTO users (id, username, display_name, email, password_hash,
                            is_service_account, created_at, token_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        prepared.id,
        prepared.username,
        prepared.displayName,
        prepared.email ?? null,
        prepared.passwordHash,
        prepared.isServiceAccount ? 1 : 0,
        prepared.createdAt,
      );
    const addGroup = database.prepare(
      "INSERT INTO user_groups (user_id, group_name) VALUES (?, ?)",
    );
    for (const group of prepared.groups) {
      addGroup.run(prepared.id, group);
    }
  } catch (error) {
    // SQLite reports the collision as a constraint failure naming the column.
    // Turning it into a sentence here keeps the caller from having to read
    // SQLite's wording to tell a taken name from a broken database.
    if (error instanceof Error && error.message.includes("users.username")) {
      throw new UsernameTakenError(prepared.username);
    }
    throw error;
  }
}

/**
 * Create an account.
 *
 * The password is hashed before anything is written, so a password that cannot
 * be stored does not leave a half-made account behind.
 */
export async function createUser(
  database: DatabaseSync,
  hasher: PasswordHasher,
  input: NewUser,
): Promise<UserRecord> {
  const prepared = await prepareUser(hasher, input);

  database.exec("BEGIN IMMEDIATE");
  try {
    insertUser(database, prepared);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  return requireUser(database, prepared.username);
}

/**
 * Stop an account from getting anything new.
 *
 * Two things happen at once, and both are needed. `disabled_at` refuses the
 * next sign-in and the next mint; the bumped `token_epoch` makes any token
 * already issued unrenewable. Neither reaches back and cancels a token that is
 * already out there — ./tokens.ts sets out exactly what that leaves open.
 *
 * `tokens_invalidated_at` moves with the epoch, here and in
 * {@link revokeUserTokens}, and those are the only two places the epoch is
 * bumped. A moment written anywhere else, or left behind by one of them, would
 * be a screen saying an account's tokens were last refused at a time they were
 * not.
 */
export function disableUser(database: DatabaseSync, username: string): UserRecord {
  const user = requireUser(database, username);
  const now = Date.now();
  database
    .prepare(
      "UPDATE users SET disabled_at = ?, token_epoch = token_epoch + 1, " +
        "tokens_invalidated_at = ? WHERE id = ?",
    )
    .run(now, now, user.id);
  return requireUser(database, user.username);
}

/**
 * Let an account sign in again.
 *
 * The epoch is deliberately not put back: tokens minted before the account was
 * disabled stay unrenewable, because whatever made disabling worth doing has
 * not become untrue.
 */
export function enableUser(database: DatabaseSync, username: string): UserRecord {
  const user = requireUser(database, username);
  database.prepare("UPDATE users SET disabled_at = NULL WHERE id = ?").run(user.id);
  return requireUser(database, user.username);
}

/**
 * Refuse every token already issued to an account, and change nothing else.
 *
 * The same bump {@link disableUser} makes, without the `disabled_at` that goes
 * with it: the person may sign in a second later and be given a token that
 * works, while everything issued before this moment is refused wherever Team is
 * the one asked. That is the operation for a token that has got out, as
 * against an account that should not have one — ./tokens.ts sets out how far
 * either of them reaches, and where neither does.
 */
export function revokeUserTokens(database: DatabaseSync, username: string): UserRecord {
  const user = requireUser(database, username);
  database
    .prepare(
      "UPDATE users SET token_epoch = token_epoch + 1, tokens_invalidated_at = ? WHERE id = ?",
    )
    .run(Date.now(), user.id);
  return requireUser(database, user.username);
}

/** Read the stored password hash of one account. */
function passwordHashOf(database: DatabaseSync, id: string): string | undefined {
  const row = database.prepare("SELECT password_hash FROM users WHERE id = ?").get(id);
  return row === undefined ? undefined : textColumn(row, "password_hash");
}

/** Replace a stored hash with one made under the current parameters. */
function setPasswordHash(database: DatabaseSync, id: string, hash: string): void {
  database.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, id);
}

/** Why a sign-in did not succeed. The person signing in is told none of this. */
export type SignInFailure =
  | "no-such-user"
  | "wrong-password"
  | "disabled"
  | "unreadable-password-hash";

/** The outcome of checking a name and a password. */
export type SignInResult =
  | { readonly kind: "signed-in"; readonly user: UserRecord }
  | { readonly kind: "refused"; readonly reason: SignInFailure };

/**
 * The one sentence a failed sign-in is reported with, whichever way it failed.
 *
 * Saying "no such user" would let anyone with a browser enumerate the accounts
 * on a Team server, and saying "your stored password could not be read" would tell them
 * which account to attack next.
 */
export const SIGN_IN_REFUSED_MESSAGE = "the username or password is not right";

/**
 * A hash to check a password against when there is no account to check it
 * against, so that an unknown username costs the same time as a known one.
 *
 * Without it, a wrong username answers in a millisecond and a wrong password
 * answers in half a second, and the difference is a list of who has an account
 * here. It is derived once per process from bytes nobody knows, so no password
 * ever matches it.
 */
let decoyHash: Promise<string> | undefined;

function decoy(hasher: PasswordHasher): Promise<string> {
  decoyHash ??= hasher.hash(randomUUID());
  return decoyHash;
}

/**
 * Check a username and password.
 *
 * A successful sign-in against a hash made with superseded parameters replaces
 * it, here and nowhere else: this is the only moment the plain password exists
 * in the process, so it is the only moment the stored hash can be upgraded.
 */
export async function authenticate(
  database: DatabaseSync,
  hasher: PasswordHasher,
  username: string,
  password: string,
): Promise<SignInResult> {
  const user = findUser(database, username);
  if (user === undefined) {
    await hasher.verify(password, await decoy(hasher));
    return { kind: "refused", reason: "no-such-user" };
  }

  const stored = passwordHashOf(database, user.id);
  if (stored === undefined) {
    return { kind: "refused", reason: "unreadable-password-hash" };
  }

  let matches: boolean;
  try {
    matches = await hasher.verify(password, stored);
  } catch (error) {
    if (error instanceof MalformedPasswordHashError) {
      return { kind: "refused", reason: "unreadable-password-hash" };
    }
    throw error;
  }
  if (!matches) {
    return { kind: "refused", reason: "wrong-password" };
  }

  // Checked after the password, not before: an attacker who learns that a name
  // exists but is disabled has learned the password was right.
  if (user.disabledAt !== undefined) {
    return { kind: "refused", reason: "disabled" };
  }

  if (hasher.needsRehash(stored)) {
    setPasswordHash(database, user.id, await hasher.hash(password));
  }
  return { kind: "signed-in", user };
}
