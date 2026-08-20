// What a Team server says out loud when it cannot read a repository.
//
// The rule about data is not in question and is asserted elsewhere: a project
// Team has not read has no history rather than a history of nought, and nothing
// on any screen turns into an error. This is the half that was missing. A
// reader that had never once worked looked exactly like a reader whose first
// clone was still running, and a defect that emptied every project on every
// real deployment survived a green suite because of it.
//
// So: one sentence when the outcome changes, and none at all while it stays the
// same.
import { describe, expect, it } from "vitest";

import { identityConfig } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import { defaultPasswordHasher } from "../src/identity/passwords.js";
import { createUser } from "../src/identity/users.js";
import { loadLoreLibrary } from "../src/lore/library.js";
import { ProjectReadings } from "../src/projects/refresh.js";
import { createProject, newProjectId } from "../src/projects/registry.js";
import { useTemporaryRoots } from "./temporary.js";

import type { DatabaseSync } from "node:sqlite";

const temporaryRoot = useTemporaryRoots("nlteam-refresh-");

/**
 * Skipped where lorelib will not load, for the reason tests/cache.test.ts is:
 * there is then no reader to drive at all. The load is attempted rather than
 * the package merely resolved.
 */
const libraryPresent = ((): boolean => {
  try {
    loadLoreLibrary();
    return true;
  } catch {
    return false;
  }
})();

/**
 * A server with one project, whose loreserver is not there.
 *
 * The port is one on the loopback that nothing is listening on, which is what
 * an operator's Team looks like when loreserver has stopped — and it is the
 * shape every failure this reports takes, whatever caused it.
 */
async function serverWithOneProject(): Promise<{
  root: string;
  database: DatabaseSync;
  name: string;
}> {
  const root = await temporaryRoot();
  const database = await openMigratedDatabase(identityLayout(root).databasePath);
  const owner = await createUser(database, defaultPasswordHasher(), {
    username: "ada",
    password: "a-password-nobody-signs-in-with",
  });
  createProject(database, {
    id: newProjectId(),
    name: "harbour",
    description: "",
    createdBy: owner.id,
  });
  return { root, database, name: "harbour" };
}

describe.skipIf(!libraryPresent)("a repository this server cannot read", () => {
  it("is said once, and not again on every pass after it", async () => {
    const { root, database, name } = await serverWithOneProject();
    const said: string[] = [];
    let passed: (() => void) | undefined;

    const readings = new ProjectReadings({
      root,
      database,
      config: identityConfig({ dataPort: 41938 }),
      onReadability: (line) => said.push(line),
      onChange: () => passed?.(),
    });

    const pass = async (): Promise<void> => {
      const finished = new Promise<void>((resolve) => {
        passed = resolve;
      });
      readings.request();
      await finished;
    };

    try {
      await pass();
      // One sentence, and it is the failure. A server where everything works
      // says nothing, so this cannot be the first success being announced.
      expect(said).toHaveLength(1);
      expect(said[0]).toMatch(new RegExp(`^cannot read ${name}'s repository: `));

      // The second pass fails in exactly the same way, and says nothing. A
      // sentence a minute for a fortnight is a log nobody reads, which is the
      // same silence in a different costume.
      await pass();
      expect(said).toHaveLength(1);
    } finally {
      readings.stop();
      database.close();
    }
  }, 300_000);

  it("names the project it is about, so a server with several is readable", async () => {
    // One sentence per project rather than one for the server. An operator
    // whose loreserver is down wants to know that; an operator with one
    // repository somebody has moved wants to know which.
    const { root, database } = await serverWithOneProject();
    createProject(database, {
      id: newProjectId(),
      name: "lighthouse",
      description: "",
      createdBy: (database.prepare("select id from users limit 1").get() as { id: string }).id,
    });

    const said: string[] = [];
    let passed: (() => void) | undefined;
    let changes = 0;
    const readings = new ProjectReadings({
      root,
      database,
      config: identityConfig({ dataPort: 41938 }),
      onReadability: (line) => said.push(line),
      onChange: () => {
        changes += 1;
        if (changes === 2) {
          passed?.();
        }
      },
    });

    try {
      const finished = new Promise<void>((resolve) => {
        passed = resolve;
      });
      readings.request();
      await finished;
    } finally {
      readings.stop();
      database.close();
    }

    expect(said).toHaveLength(2);
    expect(said.some((line) => line.startsWith("cannot read harbour's repository: "))).toBe(true);
    expect(said.some((line) => line.startsWith("cannot read lighthouse's repository: "))).toBe(
      true,
    );
  }, 300_000);
});
