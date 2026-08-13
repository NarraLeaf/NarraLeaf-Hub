// The decisions Team keeps: what one row holds, and what stops the table
// growing for ever on a Team server that answers a permission question on every
// repository access.
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  countDecisions,
  DECISION_LIMIT,
  DECISION_TRIM_SLACK,
  listDecisions,
  recordDecision,
  trimDecisions,
} from "../src/identity/audit.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-audit-");

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

/** A moment far enough back that every row written after it sorts later. */
const EARLY = Date.parse("2026-01-01T00:00:00Z");

/** Write `count` allowances, each a millisecond after the one before. */
function fillWithAllowances(connection: DatabaseSync, count: number, from = EARLY): void {
  for (let index = 0; index < count; index += 1) {
    recordDecision(connection, {
      at: from + index,
      username: "ada",
      resource: "harbour",
      allowed: true,
      detail: "owner",
    });
  }
}

/** How many of the rows on record are refusals. */
function refusals(connection: DatabaseSync): number {
  return listDecisions(connection, DECISION_LIMIT + DECISION_TRIM_SLACK).filter(
    (decision) => !decision.allowed,
  ).length;
}

describe("recordDecision", () => {
  it("keeps every part of a decision, and reads it back unchanged", async () => {
    const connection = await database();

    recordDecision(connection, {
      at: EARLY,
      username: "cleo",
      resource: "lighthouse",
      allowed: false,
      detail: "no grant",
    });

    expect(listDecisions(connection)).toEqual([
      {
        at: EARLY,
        username: "cleo",
        resource: "lighthouse",
        allowed: false,
        detail: "no grant",
      },
    ]);
  });

  it("hands them back newest first, which is the order a refusal is looked for in", async () => {
    const connection = await database();
    recordDecision(connection, {
      at: EARLY,
      username: "ada",
      resource: "harbour",
      allowed: true,
      detail: "owner",
    });
    recordDecision(connection, {
      at: EARLY + 60_000,
      username: "bob",
      resource: "harbour",
      allowed: true,
      detail: "write",
    });

    expect(listDecisions(connection).map((decision) => decision.username)).toEqual(["bob", "ada"]);
  });

  it("leaves the connection as durable as it found it", async () => {
    const connection = await database();
    const before = connection.prepare("PRAGMA synchronous").get();

    recordDecision(connection, {
      username: "ada",
      resource: "harbour",
      allowed: true,
      detail: "owner",
    });

    // A decision is written without waiting for the disk, and that is the whole
    // of what it applies to. A setting left relaxed would make every account,
    // invitation and grant Team writes afterwards less durable than the file was
    // opened to be, and nothing would say so.
    expect(connection.prepare("PRAGMA synchronous").get()).toEqual(before);
  });

  it("takes the moment from the clock when nobody names one", async () => {
    const connection = await database();
    const before = Date.now();

    recordDecision(connection, {
      username: "ada",
      resource: "harbour",
      allowed: true,
      detail: "owner",
    });

    const [only] = listDecisions(connection);
    expect(only?.at).toBeGreaterThanOrEqual(before);
    expect(only?.at).toBeLessThanOrEqual(Date.now());
  });
});

describe("the bound on how many are kept", () => {
  it("holds the table inside the limit and its slack, however many are made", async () => {
    const connection = await database();

    fillWithAllowances(connection, DECISION_LIMIT + DECISION_TRIM_SLACK + 10);

    expect(countDecisions(connection)).toBeLessThanOrEqual(DECISION_LIMIT + DECISION_TRIM_SLACK);
  });

  it("lets the table run past the limit rather than deleting on every decision", async () => {
    const connection = await database();

    fillWithAllowances(connection, DECISION_LIMIT + 100);

    // A Team server that trimmed on every decision would sit exactly on the limit, and
    // would be paying for a DELETE on the path that answers every repository
    // access. Standing above it is what the slack buys.
    expect(countDecisions(connection)).toBeGreaterThan(DECISION_LIMIT);
  });

  it("drops the routine allowances before it drops a refusal", async () => {
    const connection = await database();
    // The oldest row in the table, and the one worth keeping. Everything after
    // it is an ordinary allowance, and there are enough of them to force the
    // bound to choose.
    recordDecision(connection, {
      at: EARLY,
      username: "cleo",
      resource: "lighthouse",
      allowed: false,
      detail: "no grant",
    });

    fillWithAllowances(connection, DECISION_LIMIT + DECISION_TRIM_SLACK + 10, EARLY + 1);

    expect(refusals(connection)).toBe(1);
    expect(
      listDecisions(connection, DECISION_LIMIT + DECISION_TRIM_SLACK).find(
        (decision) => !decision.allowed,
      ),
    ).toMatchObject({ username: "cleo", resource: "lighthouse" });
  });
});

describe("trimDecisions", () => {
  it("removes nothing from a table that is inside its bound", async () => {
    const connection = await database();
    fillWithAllowances(connection, 10);

    expect(trimDecisions(connection)).toBe(0);
    expect(countDecisions(connection)).toBe(10);
  });

  it("brings a table that is over the bound back to it", async () => {
    const connection = await database();
    fillWithAllowances(connection, DECISION_LIMIT + 40);

    trimDecisions(connection);

    expect(countDecisions(connection)).toBe(DECISION_LIMIT);
  });
});
