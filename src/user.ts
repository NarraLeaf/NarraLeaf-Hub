/**
 * The `user` commands: list the accounts, make one from an invitation, and
 * take access away or give it back.
 *
 * Disabling and enabling say what they did and what they did not do. An
 * operator who has just disabled somebody is entitled to know that a token
 * already in that person's hands works until it expires — src/identity/tokens.ts
 * explains why nothing here can shorten that.
 */
import type { WriteText } from "./cli.js";
import { DEFAULT_IDENTITY } from "./identity/config.js";
import { openMigratedDatabase } from "./identity/database.js";
import { redeemInvite } from "./identity/invites.js";
import { identityLayout } from "./identity/layout.js";
import { defaultPasswordHasher } from "./identity/passwords.js";
import { disableUser, enableUser, listUsers, type UserRecord } from "./identity/users.js";
import { readPassword } from "./stdin.js";

export interface UserListOptions {
  readonly root: string;
}

export interface UserCreateOptions {
  readonly root: string;
  readonly username: string;
  /** The invite code being redeemed. */
  readonly code: string;
  readonly displayName: string | undefined;
  readonly email: string | undefined;
  readonly isServiceAccount: boolean;
}

export interface UserStateOptions {
  readonly root: string;
  readonly username: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One account, on one line, with the columns padded to line up. */
function renderUser(user: UserRecord, usernameWidth: number): string {
  const state = user.disabledAt === undefined ? "enabled " : "disabled";
  const kind = user.isServiceAccount ? "service" : "person ";
  const groups = user.groups.length === 0 ? "-" : user.groups.join(",");
  return `${user.username.padEnd(usernameWidth)}  ${state}  ${kind}  ${groups}`;
}

/** Print every account. Returns the process exit code. */
export async function userList(
  options: UserListOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  const database = await openMigratedDatabase(layout.databasePath);
  try {
    const users = listUsers(database);
    if (users.length === 0) {
      stdout("no accounts yet. Run up to be given an invite code for the first one.\n");
      return 0;
    }
    const width = Math.max(...users.map((user) => user.username.length));
    for (const user of users) {
      stdout(`${renderUser(user, width)}\n`);
    }
    return 0;
  } catch (error) {
    stderr(`nlhub: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}

/** Turn an invite code into an account. Returns the process exit code. */
export async function userCreate(
  options: UserCreateOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  let password: string;
  try {
    password = await readPassword();
  } catch (error) {
    stderr(`nlhub: ${describeError(error)}\n`);
    return 2;
  }

  const database = await openMigratedDatabase(layout.databasePath);
  try {
    const { user } = await redeemInvite(database, defaultPasswordHasher(), options.code, {
      username: options.username,
      password,
      ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
      ...(options.email === undefined ? {} : { email: options.email }),
      isServiceAccount: options.isServiceAccount,
    });
    stdout(`created ${user.username} (${user.id})\n`);
    stdout(`groups: ${user.groups.join(", ")}\n`);
    return 0;
  } catch (error) {
    stderr(`nlhub: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}

/** Stop an account getting anything new. Returns the process exit code. */
export async function userDisable(
  options: UserStateOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  const database = await openMigratedDatabase(layout.databasePath);
  try {
    const user = disableUser(database, options.username);
    stdout(`disabled ${user.username}\n`);
    // Stated every time, because the alternative is an operator believing
    // access ended the moment they pressed return.
    stdout(
      "Tokens already issued to them keep working until they expire, at most one token " +
        `lifetime away (${Math.round(DEFAULT_IDENTITY.tokenLifetimeSeconds / 60)} minutes ` +
        "unless --token-lifetime said otherwise). Nothing new will be issued.\n",
    );
    return 0;
  } catch (error) {
    stderr(`nlhub: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}

/** Let an account sign in again. Returns the process exit code. */
export async function userEnable(
  options: UserStateOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  const database = await openMigratedDatabase(layout.databasePath);
  try {
    const user = enableUser(database, options.username);
    stdout(`enabled ${user.username}\n`);
    return 0;
  } catch (error) {
    stderr(`nlhub: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}
