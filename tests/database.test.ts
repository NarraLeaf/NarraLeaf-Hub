import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  migrate,
  openDatabase,
  openMigratedDatabase,
  schemaVersion,
  SchemaTooNewError,
  SCHEMA_VERSION,
  textColumn,
} from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-database-");

/** The names of every table in an open database. */
function tableNames(database: DatabaseSync): string[] {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => textColumn(row, "name"));
}

describe("migrate", () => {
  it("takes a file that does not exist yet to the current version", async () => {
    const root = await temporaryRoot();
    const path = identityLayout(root).databasePath;
    expect(existsSync(path)).toBe(false);

    const database = await openDatabase(path);
    try {
      expect(schemaVersion(database)).toBe(0);
      expect(migrate(database, path)).toBe(SCHEMA_VERSION);
      expect(tableNames(database)).toEqual(
        expect.arrayContaining([
          "decisions",
          "invites",
          "schema_version",
          "settings",
          "user_groups",
          "users",
        ]),
      );
    } finally {
      database.close();
    }
    expect(existsSync(path)).toBe(true);
  });

  it("adds a later migration to a file that already has accounts in it", async () => {
    const root = await temporaryRoot();
    const path = identityLayout(root).databasePath;
    const database = await openDatabase(path);
    try {
      migrate(database, path);
      database
        .prepare(
          `INSERT INTO users (id, username, display_name, password_hash, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("9a1c0e2e", "ada", "Ada Lovelace", "scrypt$N=16384,r=8,p=1$c2FsdA==$aGFzaA==", 1);

      // Put the file back to the version before the newest migration, rather
      // than writing out that older schema again here: a second copy of it in
      // this file would be one more thing to keep in step with the migration
      // list.
      database.exec("DROP TABLE decisions");
      database.prepare("DELETE FROM schema_version WHERE version = ?").run(SCHEMA_VERSION);
      expect(schemaVersion(database)).toBe(SCHEMA_VERSION - 1);

      expect(migrate(database, path)).toBe(SCHEMA_VERSION);

      expect(tableNames(database)).toContain("decisions");
      // The account is still there. A migration that took the file back to
      // something empty would pass every check about tables and lose a Team server.
      expect(database.prepare("SELECT username FROM users").all()).toEqual([{ username: "ada" }]);
    } finally {
      database.close();
    }
  });

  it("does nothing the second time, and nothing the third", async () => {
    const root = await temporaryRoot();
    const path = identityLayout(root).databasePath;

    const database = await openDatabase(path);
    try {
      migrate(database, path);
      const first = database.prepare("SELECT version, applied_at FROM schema_version").all();

      expect(migrate(database, path)).toBe(SCHEMA_VERSION);
      expect(migrate(database, path)).toBe(SCHEMA_VERSION);

      // Same rows, same timestamps: a migration that had run again would have
      // written another one, or failed on the table it was creating.
      expect(database.prepare("SELECT version, applied_at FROM schema_version").all()).toEqual(
        first,
      );
    } finally {
      database.close();
    }
  });

  it("records one row per migration, with when it was applied", async () => {
    const root = await temporaryRoot();
    const database = await openMigratedDatabase(identityLayout(root).databasePath);
    try {
      const rows = database.prepare("SELECT version, applied_at FROM schema_version").all();

      expect(rows).toHaveLength(SCHEMA_VERSION);
      for (const row of rows) {
        expect(typeof row["applied_at"]).toBe("number");
      }
    } finally {
      database.close();
    }
  });

  it("refuses a file written by a newer Team rather than working on it", async () => {
    const root = await temporaryRoot();
    const path = identityLayout(root).databasePath;
    const database = await openDatabase(path);
    try {
      migrate(database, path);
      database
        .prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)")
        .run(SCHEMA_VERSION + 1, Date.now());

      expect(() => migrate(database, path)).toThrow(SchemaTooNewError);
    } finally {
      database.close();
    }
  });

  it("keeps its file under the storage root, beside everything else Team writes", async () => {
    const root = await temporaryRoot();
    const layout = identityLayout(root);

    expect(layout.databasePath).toBe(join(layout.root, "team.db"));
    expect(layout.keysDir).toBe(join(layout.root, "keys"));
  });
});
