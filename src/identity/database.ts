/**
 * The file that holds the accounts and the projects: `<root>/hub.db`.
 *
 * Storage is node's built-in SQLite, which is why Hub can keep a database
 * without gaining a dependency. There is exactly one writer — the Hub process
 * — so nothing here worries about connection pools.
 *
 * The schema is versioned and only ever moves forward. Every change is a new
 * migration appended to the list below; an already-released migration is never
 * edited, because the file it has already run against is the one holding the
 * user accounts, and rewriting history here means two installations disagreeing
 * about what version 1 means.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
// Type-only, and therefore erased: the module itself is loaded on demand, for
// the reason set out above `loadSqlite`.
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";

/** One row as node:sqlite hands it over. */
export type Row = Record<string, SQLOutputValue>;

/** Raised when a value in the database is not of the type its column implies. */
export class ColumnTypeError extends Error {
  constructor(
    readonly column: string,
    readonly expected: string,
  ) {
    super(
      `hub.db holds a ${column} that is not ${expected}. The file was written by ` +
        "something other than this version of Hub.",
    );
    this.name = "ColumnTypeError";
  }
}

/** Read a text column, insisting that it really is text. */
export function textColumn(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new ColumnTypeError(column, "text");
  }
  return value;
}

/** Read a text column that is allowed to be NULL. */
export function optionalTextColumn(row: Row, column: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ColumnTypeError(column, "text or null");
  }
  return value;
}

/**
 * Read an integer column.
 *
 * node:sqlite hands back a `bigint` only for values outside the range a double
 * represents exactly. Nothing Hub stores is that large — the biggest numbers
 * here are millisecond timestamps — so one is narrowed rather than propagated.
 */
export function integerColumn(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value !== "number") {
    throw new ColumnTypeError(column, "an integer");
  }
  return value;
}

/** Read an integer column that is allowed to be NULL. */
export function optionalIntegerColumn(row: Row, column: string): number | undefined {
  const value = row[column];
  if (value === null || value === undefined) {
    return undefined;
  }
  return integerColumn(row, column);
}

/** Read an integer column that stands for a boolean, SQLite's 0 or 1. */
export function booleanColumn(row: Row, column: string): boolean {
  return integerColumn(row, column) !== 0;
}

/** One step forward from the previous schema version. */
interface Migration {
  readonly version: number;
  /** What this migration is for, in one line. */
  readonly description: string;
  readonly statements: readonly string[];
}

/**
 * Every migration, in order, oldest first.
 *
 * Appending is the only edit this list ever takes.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: "users, their groups, and invite codes",
    statements: [
      // `id` is a random identifier rather than a row number: it becomes the
      // `sub` claim of every token, and a rename or a re-import must not turn
      // one person into another. `disabled_at` NULL means the account may sign
      // in. `token_epoch` is the counter that invalidates outstanding tokens —
      // src/identity/tokens.ts states exactly what that does and does not do.
      `CREATE TABLE users (
         id                 TEXT    NOT NULL PRIMARY KEY,
         username           TEXT    NOT NULL UNIQUE,
         display_name       TEXT    NOT NULL,
         email              TEXT,
         password_hash      TEXT    NOT NULL,
         is_service_account INTEGER NOT NULL DEFAULT 0,
         created_at         INTEGER NOT NULL,
         disabled_at        INTEGER,
         token_epoch        INTEGER NOT NULL DEFAULT 1
       ) STRICT`,
      // Group membership is a table rather than a column so that a person can
      // be in none, one or several; the `groups` claim is read straight from
      // it. Deleting a user takes their memberships with them.
      `CREATE TABLE user_groups (
         user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         group_name TEXT NOT NULL,
         PRIMARY KEY (user_id, group_name)
       ) STRICT`,
      // Only the hash of an invite code is kept, for the same reason only the
      // hash of a password is: whoever reads this file must not come away able
      // to redeem an invite. `is_bootstrap` marks the code `up` prints when no
      // account exists yet, so that a later run can withdraw an unused one
      // instead of leaving a second live code behind.
      `CREATE TABLE invites (
         code_hash    TEXT    NOT NULL PRIMARY KEY,
         role         TEXT    NOT NULL,
         is_bootstrap INTEGER NOT NULL DEFAULT 0,
         created_at   INTEGER NOT NULL,
         expires_at   INTEGER NOT NULL,
         used_at      INTEGER,
         used_by      TEXT REFERENCES users(id)
       ) STRICT`,
    ],
  },
  {
    version: 2,
    description: "projects, and who may reach them",
    statements: [
      // `id` is the repository's own id as loreserver holds it: sixteen bytes,
      // written here as thirty-two lower-case hex characters. It is not a
      // second identifier that has to be mapped to that one — a resource id in
      // a permission question is this string with `urc-` in front of it, and
      // src/projects/registry.ts is where that is spelled out.
      //
      // `created_by` is the account that asked for the repository. It survives
      // that account being deleted only in the sense that the row does not:
      // there is no such thing as a project nobody made.
      `CREATE TABLE projects (
         id          TEXT    NOT NULL PRIMARY KEY,
         name        TEXT    NOT NULL UNIQUE,
         description TEXT    NOT NULL,
         created_by  TEXT    NOT NULL REFERENCES users(id),
         created_at  INTEGER NOT NULL
       ) STRICT`,
      // One row per person per project, and no row for somebody with no access:
      // this table is the whole of the answer to "may this caller touch this
      // repository", so an absent row is a refusal rather than a default.
      //
      // `level` is `read`, `write` or `owner`. Three words, ordered, with no
      // table of verbs behind them — loreserver does not read the verbs, and a
      // permission system nobody consults is a place for bugs to hide.
      `CREATE TABLE project_grants (
         project_id TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
         level      TEXT    NOT NULL,
         granted_by TEXT    REFERENCES users(id),
         granted_at INTEGER NOT NULL,
         PRIMARY KEY (project_id, user_id)
       ) STRICT`,
      // Every permission question names a person and asks about their projects,
      // so that is the direction the index runs in.
      "CREATE INDEX project_grants_by_user ON project_grants (user_id)",
    ],
  },
  {
    version: 3,
    description: "settings an operator can change without a new build of Hub",
    statements: [
      // One row per setting somebody has chosen, and no row for one left alone.
      // An absent row is not a missing value: it means the default in
      // src/identity/config.ts answers for that setting, so a later version of
      // Hub that changes a default reaches every installation that never
      // touched it. Writing the defaults in here as the migration ran would
      // freeze them at whatever this build thinks, and nothing would say so.
      //
      // `value` is text whatever the setting means, because a column per type
      // is a schema change every time a setting of a new type appears.
      // src/identity/settings.ts is where each key is turned back into the
      // thing it stands for, and where a value that will not turn back is
      // refused rather than quietly defaulted around.
      `CREATE TABLE settings (
         key        TEXT    NOT NULL PRIMARY KEY,
         value      TEXT    NOT NULL,
         updated_at INTEGER NOT NULL
       ) STRICT`,
    ],
  },
  {
    version: 4,
    description: "when an account's tokens were last made unrenewable",
    statements: [
      // Beside `token_epoch` rather than instead of it. The counter is what a
      // token is checked against; this is only the moment it last moved, and
      // nothing decides anything from it.
      //
      // Rows that already exist keep NULL, and that is deliberate. There is no
      // honest timestamp for a bump that happened before this column existed,
      // and the obvious invention — the moment this migration ran — would read
      // as every account on the Hub having had its tokens refused on the day
      // Hub was upgraded. Absent is drawn as "unknown", which is true.
      "ALTER TABLE users ADD COLUMN tokens_invalidated_at INTEGER",
    ],
  },
  {
    version: 5,
    description: "the authorization decisions Hub has made",
    statements: [
      // One row per decision. Before this table there was none: every decision
      // went to the log of the `up` process that made it and nowhere else, so a
      // Hub that had been running for a month could not say who had reached
      // what, and the screen that shows the last few decisions had nothing to
      // show.
      //
      // `username` is text rather than a reference to `users`, and it is the
      // one column that must not be a foreign key. A row that cascaded away
      // with the account would delete exactly the record somebody deleted an
      // account over. The same goes for `resource`: it holds the project's name
      // as it stood when the decision was made, so the row still says which
      // project it was about after that project has been forgotten.
      //
      // There is no index. src/identity/audit.ts keeps the table to a bounded
      // number of rows, and an index would be a write on the path that answers
      // every repository access in order to speed up a query a person makes
      // when they open a screen.
      `CREATE TABLE decisions (
         id       INTEGER NOT NULL PRIMARY KEY,
         at       INTEGER NOT NULL,
         username TEXT    NOT NULL,
         resource TEXT    NOT NULL,
         allowed  INTEGER NOT NULL,
         detail   TEXT    NOT NULL
       ) STRICT`,
    ],
  },
];

/** The schema version this build of Hub writes and expects. */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);

/** Raised when the database on disk is newer than this build understands. */
export class SchemaTooNewError extends Error {
  constructor(
    readonly path: string,
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `${path} is at schema version ${found}, and this version of Hub understands ${supported}. ` +
        "It was written by a newer Hub. Upgrade Hub rather than downgrading the file.",
    );
    this.name = "SchemaTooNewError";
  }
}

/**
 * node:sqlite announces itself as experimental the first time it is used, on
 * stderr, through the ordinary process warning channel. Hub is a program an
 * operator leaves running, and a line about node internals on every start is
 * noise they cannot act on.
 *
 * Only that one warning is dropped. Every other warning — a deprecation, an
 * unhandled rejection, a `MaxListenersExceededWarning` — is handed to the
 * listeners that were already there, so nothing else is hidden by this.
 */
let warningFilterInstalled = false;

function suppressSqliteExperimentalWarning(): void {
  if (warningFilterInstalled) {
    return;
  }
  warningFilterInstalled = true;

  type WarningListener = (warning: Error) => void;
  const existing = process.listeners("warning") as WarningListener[];
  process.removeAllListeners("warning");
  process.on("warning", (warning: Error) => {
    if (warning.name === "ExperimentalWarning" && warning.message.includes("SQLite")) {
      return;
    }
    for (const listener of existing) {
      listener(warning);
    }
  });
}

let sqlite: Promise<typeof import("node:sqlite")> | undefined;

/**
 * Load `node:sqlite`, with the filter above in place first.
 *
 * The warning is emitted as the module loads, not as it is used, and a static
 * import is evaluated before any code in this file could install a filter. So
 * the module is imported on demand instead — which is also why opening a
 * database is asynchronous, and why running `nlhub --version` neither loads
 * SQLite nor says anything about it.
 */
function loadSqlite(): Promise<typeof import("node:sqlite")> {
  suppressSqliteExperimentalWarning();
  sqlite ??= import("node:sqlite");
  return sqlite;
}

/**
 * Open `path`, creating it and its directory if they are not there.
 *
 * Foreign keys are switched on per connection — SQLite's default is off, and a
 * `REFERENCES` clause that nothing enforces is a comment. The write-ahead log
 * is what lets a reader run while the Hub process writes.
 */
export async function openDatabase(path: string): Promise<DatabaseSync> {
  const { DatabaseSync } = await loadSqlite();
  mkdirSync(dirname(path), { recursive: true });

  const database = new DatabaseSync(path);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  return database;
}

/** The version an open database is at; 0 for one nothing has been applied to. */
export function schemaVersion(database: DatabaseSync): number {
  database.exec(
    `CREATE TABLE IF NOT EXISTS schema_version (
       version    INTEGER NOT NULL PRIMARY KEY,
       applied_at INTEGER NOT NULL
     ) STRICT`,
  );
  const row = database.prepare("SELECT MAX(version) AS version FROM schema_version").get();
  if (row === undefined || row["version"] === null || row["version"] === undefined) {
    return 0;
  }
  return integerColumn(row, "version");
}

/**
 * Bring an open database up to {@link SCHEMA_VERSION}, and return the version
 * it is now at.
 *
 * Applying nothing is a normal outcome: this runs on every start, and a
 * database already at the current version is left alone. Each migration is one
 * transaction, so a failure part-way leaves the file at the version before it
 * rather than half-way through.
 *
 * One row is recorded per migration rather than one row overwritten, so the
 * file says when each step was applied.
 */
export function migrate(database: DatabaseSync, path = "hub.db"): number {
  let current = schemaVersion(database);
  if (current > SCHEMA_VERSION) {
    throw new SchemaTooNewError(path, current, SCHEMA_VERSION);
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) {
      continue;
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of migration.statements) {
        database.exec(statement);
      }
      database
        .prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)")
        .run(migration.version, Date.now());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    current = migration.version;
  }

  return current;
}

/** Open the database at `path` and migrate it in one step. */
export async function openMigratedDatabase(path: string): Promise<DatabaseSync> {
  const database = await openDatabase(path);
  try {
    migrate(database, path);
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}
