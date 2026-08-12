/**
 * Invite codes: the only way an account comes into existence.
 *
 * A code is a secret, so it is treated like one. It is shown once, at the
 * moment it is made, and only its SHA-256 is written down — a person who can
 * read `hub.db` can already do worse things than make an account, but a backup
 * of it, or a copy sent somewhere for support, must not be a bag of usable
 * invitations.
 *
 * Codes are compared in constant time and every candidate row is examined, so
 * neither the comparison nor the number of rows it looked at says how much of a
 * guess was right.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  booleanColumn,
  integerColumn,
  optionalIntegerColumn,
  optionalTextColumn,
  textColumn,
  type Row,
} from "./database.js";
import type { PasswordHasher } from "./passwords.js";
import { insertUser, prepareUser, requireUser, type NewUser, type UserRecord } from "./users.js";

/** One invitation. The code itself is not among these fields, by design. */
export interface InviteRecord {
  /** SHA-256 of the normalised code, lower-case hex. */
  readonly codeHash: string;
  /** The group the account made from this invite joins. */
  readonly role: string;
  /** True for the code `up` prints when a Hub holds no accounts at all. */
  readonly isBootstrap: boolean;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly usedAt: number | undefined;
  /** Id of the account that was made from it. */
  readonly usedBy: string | undefined;
}

/** A freshly made invite, and the one look anybody gets at its code. */
export interface CreatedInvite {
  readonly code: string;
  readonly invite: InviteRecord;
}

/** Raised when a code matches no invitation. */
export class UnknownInviteError extends Error {
  constructor() {
    super("that invite code is not one this Hub issued.");
    this.name = "UnknownInviteError";
  }
}

/** Raised when a code was already redeemed. */
export class InviteAlreadyUsedError extends Error {
  constructor(readonly usedAt: number) {
    super(
      `that invite code was already used, on ${new Date(usedAt).toISOString()}. ` +
        "Each code makes one account.",
    );
    this.name = "InviteAlreadyUsedError";
  }
}

/** Raised when a code is past its expiry. */
export class InviteExpiredError extends Error {
  constructor(readonly expiredAt: number) {
    super(`that invite code expired on ${new Date(expiredAt).toISOString()}.`);
    this.name = "InviteExpiredError";
  }
}

/** Raised when a role is not a name a group can have. */
export class InvalidRoleError extends Error {
  constructor(role: string) {
    super(
      `"${role}" cannot be a role. A role is 1 to 32 characters of a-z, 0-9, dash and ` +
        "underscore, and starts with a letter.",
    );
    this.name = "InvalidRoleError";
  }
}

/** The role an invite grants when none is named. */
export const DEFAULT_ROLE = "member";

/** How long an invite lasts when no expiry is named. */
export const DEFAULT_INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

const ROLE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Crockford's base32 alphabet: no I, L, O or U.
 *
 * Codes get read off one screen and typed into another, so the encoding leaves
 * out the characters that are misread as one another, and reading is forgiving
 * about the rest — see {@link normaliseCode}.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Bytes of randomness in a code. 160 bits, which is 32 encoded characters. */
const CODE_BYTES = 20;

/** Characters per dash-separated group, for reading aloud. */
const GROUP_SIZE = 8;

function encodeBase32(bytes: Buffer): string {
  let text = "";
  let bits = 0;
  let accumulator = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      text += ALPHABET[(accumulator >> bits) & 0b11111];
    }
  }
  if (bits > 0) {
    text += ALPHABET[(accumulator << (5 - bits)) & 0b11111];
  }
  return text;
}

function group(text: string): string {
  const groups: string[] = [];
  for (let index = 0; index < text.length; index += GROUP_SIZE) {
    groups.push(text.slice(index, index + GROUP_SIZE));
  }
  return groups.join("-");
}

/**
 * Reduce a code as typed to the exact characters it was made from.
 *
 * Dashes and spaces are decoration, case is not meaningful, and the letters
 * Crockford's alphabet leaves out are folded onto the digits they are mistaken
 * for. Two codes cannot collide under this: the letters being mapped are not in
 * the alphabet, so nothing that was generated is changed by it.
 */
export function normaliseCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replaceAll("I", "1")
    .replaceAll("L", "1")
    .replaceAll("O", "0")
    .replaceAll("U", "V");
}

/** The digest stored for a code. */
function digestOf(code: string): Buffer {
  return createHash("sha256").update(normaliseCode(code), "utf8").digest();
}

/** Make one code. Exported so a test can show two calls do not repeat. */
export function generateCode(): string {
  return group(encodeBase32(randomBytes(CODE_BYTES)));
}

function toInvite(row: Row): InviteRecord {
  return {
    codeHash: textColumn(row, "code_hash"),
    role: textColumn(row, "role"),
    isBootstrap: booleanColumn(row, "is_bootstrap"),
    createdAt: integerColumn(row, "created_at"),
    expiresAt: integerColumn(row, "expires_at"),
    usedAt: optionalIntegerColumn(row, "used_at"),
    usedBy: optionalTextColumn(row, "used_by"),
  };
}

/** What an invite is made with. */
export interface NewInvite {
  readonly role?: string;
  readonly lifetimeMs?: number;
  /** Marks the code `up` prints for a Hub with no accounts. */
  readonly isBootstrap?: boolean;
}

/**
 * Create an invitation, returning the code once.
 *
 * The code is not stored and cannot be recovered afterwards. A caller that
 * loses it has to make another invite, which is the intended trade: the
 * alternative is a database that can hand out working invitations to whoever
 * reads it.
 */
export function createInvite(
  database: DatabaseSync,
  options: NewInvite = {},
): CreatedInvite {
  const role = options.role ?? DEFAULT_ROLE;
  if (!ROLE_PATTERN.test(role)) {
    throw new InvalidRoleError(role);
  }

  const code = generateCode();
  const createdAt = Date.now();
  const invite: InviteRecord = {
    codeHash: digestOf(code).toString("hex"),
    role,
    isBootstrap: options.isBootstrap === true,
    createdAt,
    expiresAt: createdAt + (options.lifetimeMs ?? DEFAULT_INVITE_LIFETIME_MS),
    usedAt: undefined,
    usedBy: undefined,
  };

  database
    .prepare(
      `INSERT INTO invites (code_hash, role, is_bootstrap, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      invite.codeHash,
      invite.role,
      invite.isBootstrap ? 1 : 0,
      invite.createdAt,
      invite.expiresAt,
    );

  return { code, invite };
}

/** Every invitation, newest first. */
export function listInvites(database: DatabaseSync): InviteRecord[] {
  return database
    .prepare("SELECT * FROM invites ORDER BY created_at DESC")
    .all()
    .map(toInvite);
}

/**
 * Find the invitation a code belongs to.
 *
 * Every row is compared, and the comparison itself is `timingSafeEqual`, so
 * neither the answer's timing nor the loop's length depends on how close a
 * guess came. The lookup is not an indexed one for the same reason.
 */
function findByCode(database: DatabaseSync, code: string): InviteRecord | undefined {
  const digest = digestOf(code);
  let found: InviteRecord | undefined;
  for (const row of database.prepare("SELECT * FROM invites").all()) {
    const stored = Buffer.from(textColumn(row, "code_hash"), "hex");
    if (stored.length === digest.length && timingSafeEqual(stored, digest)) {
      found = toInvite(row);
    }
  }
  return found;
}

/**
 * Withdraw every unused bootstrap code.
 *
 * `up` prints a fresh code each time it finds a Hub with no accounts, because
 * it cannot print the previous one — it never had it, only its hash. Dropping
 * the old ones keeps exactly one live code at a time instead of one per start.
 *
 * Returns how many were withdrawn.
 */
export function withdrawUnusedBootstrapInvites(database: DatabaseSync): number {
  const changes = database
    .prepare("DELETE FROM invites WHERE is_bootstrap = 1 AND used_at IS NULL")
    .run().changes;
  return Number(changes);
}

/**
 * Turn a code into an account.
 *
 * The account is written and the invite marked used in one transaction, and the
 * marking only counts if the invite was still unused at that moment. Two people
 * redeeming the same code at the same time therefore end with one account and
 * one failure, rather than two accounts.
 */
export async function redeemInvite(
  database: DatabaseSync,
  hasher: PasswordHasher,
  code: string,
  account: NewUser,
): Promise<{ user: UserRecord; invite: InviteRecord }> {
  const invite = findByCode(database, code);
  if (invite === undefined) {
    throw new UnknownInviteError();
  }
  if (invite.usedAt !== undefined) {
    throw new InviteAlreadyUsedError(invite.usedAt);
  }
  if (invite.expiresAt <= Date.now()) {
    throw new InviteExpiredError(invite.expiresAt);
  }

  // Hashing happens outside the transaction; it is the slow part, and holding a
  // write lock for half a second is time other writers spend waiting.
  const prepared = await prepareUser(hasher, {
    ...account,
    groups: [...(account.groups ?? []), invite.role],
  });

  database.exec("BEGIN IMMEDIATE");
  try {
    insertUser(database, prepared);
    const claimed = database
      .prepare(
        "UPDATE invites SET used_at = ?, used_by = ? WHERE code_hash = ? AND used_at IS NULL",
      )
      .run(Date.now(), prepared.id, invite.codeHash);
    if (Number(claimed.changes) !== 1) {
      throw new InviteAlreadyUsedError(Date.now());
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  const used = findByCode(database, code);
  return {
    user: requireUser(database, prepared.username),
    invite: used ?? invite,
  };
}
