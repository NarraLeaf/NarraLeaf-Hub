/**
 * The projects Hub knows about, and who may reach each of them.
 *
 * A project is one loreserver repository. Hub keeps the row that says who made
 * it and who it has been shared with; loreserver keeps the contents and asks
 * Hub, on every access, whether the caller is one of those people.
 *
 * The two systems agree on an identifier and nothing else. loreserver's
 * repository id is sixteen bytes; it appears in a permission question as a
 * resource id, which is those bytes as lower-case hex with `urc-` in front. So
 * that is what is stored — the hex — and {@link resourceIdOf} is the only place
 * the prefix is written. A second identifier of Hub's own would have to be
 * mapped back to this one at exactly the moment a wrong answer costs somebody
 * their access.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import {
  integerColumn,
  optionalTextColumn,
  textColumn,
  type Row,
} from "../identity/database.js";

/**
 * What one person may do with one project.
 *
 * Three words, ordered: an owner may do what a writer may, and a writer may do
 * what a reader may. There is deliberately no table of verbs behind them —
 * loreserver 0.8.6 does not read the verbs it is sent, and a permission system
 * nobody consults is somewhere for a mistake to sit unnoticed.
 */
export type AccessLevel = "read" | "write" | "owner";

/** The levels a `--level` option accepts; ownership comes from creating. */
export const GRANTABLE_LEVELS: readonly AccessLevel[] = ["read", "write"];

/** Every level, weakest first, for comparing two. */
const LEVEL_ORDER: readonly AccessLevel[] = ["read", "write", "owner"];

/** True when `level` is at least `atLeast`. */
export function levelAllows(level: AccessLevel, atLeast: AccessLevel): boolean {
  return LEVEL_ORDER.indexOf(level) >= LEVEL_ORDER.indexOf(atLeast);
}

/** Read a level out of the database, insisting it is one of the three. */
function levelColumn(row: Row, column: string): AccessLevel {
  const value = textColumn(row, column);
  const level = LEVEL_ORDER.find((known) => known === value);
  if (level === undefined) {
    throw new Error(
      `hub.db holds an access level of "${value}", and the levels are ${LEVEL_ORDER.join(", ")}.`,
    );
  }
  return level;
}

/**
 * The verbs named in an answer about a project.
 *
 * loreserver takes the presence of the resource id as the answer and never
 * looks at this list. It is filled in because the field exists and because the
 * audit line is more use with it than without.
 */
export function permissionsFor(level: AccessLevel): readonly string[] {
  switch (level) {
    case "read":
      return ["read"];
    case "write":
      return ["read", "write"];
    case "owner":
      return ["read", "write", "owner"];
  }
}

/** One project. */
export interface ProjectRecord {
  /** The repository id, sixteen bytes as thirty-two lower-case hex characters. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** The account that created it, by user id. */
  readonly createdBy: string;
  /** Milliseconds since the epoch. */
  readonly createdAt: number;
}

/** One person's access to one project. */
export interface GrantRecord {
  readonly projectId: string;
  readonly userId: string;
  readonly level: AccessLevel;
  /** Who gave it; absent for a grant nobody gave, which no code here writes. */
  readonly grantedBy: string | undefined;
  readonly grantedAt: number;
}

/** A project somebody may reach, and how far. */
export interface ReachableProject {
  readonly project: ProjectRecord;
  readonly level: AccessLevel;
}

/** What a resource id has in front of the repository id. */
export const RESOURCE_PREFIX = "urc-";

/** A repository id is sixteen bytes, written as hex. */
const REPOSITORY_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * A project name, as loreserver will accept it.
 *
 * loreserver has validation rules of its own and refuses a name that breaks
 * them, so this is not the only check; it is the one that happens before a
 * repository is created and a row is written.
 */
const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/** Raised when a name cannot be a project name. */
export class InvalidProjectNameError extends Error {
  constructor(name: string) {
    super(
      `"${name}" cannot be a project name. A project name is 1 to 64 characters of ` +
        "letters, digits, dot, dash and underscore, and starts with a letter or a digit.",
    );
    this.name = "InvalidProjectNameError";
  }
}

/** Raised when a project name is already in use. */
export class ProjectNameTakenError extends Error {
  constructor(readonly projectName: string) {
    super(`there is already a project called ${projectName}.`);
    this.name = "ProjectNameTakenError";
  }
}

/** Raised when nothing goes by a name or id a command was given. */
export class UnknownProjectError extends Error {
  constructor(readonly reference: string) {
    super(`there is no project called ${reference}.`);
    this.name = "UnknownProjectError";
  }
}

/** Raised when a revocation would leave a project with no owner. */
export class OwnerGrantError extends Error {
  constructor(readonly projectName: string) {
    super(
      `that account owns ${projectName}, and an owner's access is not revoked. ` +
        "Delete the project instead.",
    );
    this.name = "OwnerGrantError";
  }
}

/** The resource id loreserver asks about for one project. */
export function resourceIdOf(projectId: string): string {
  return `${RESOURCE_PREFIX}${projectId}`;
}

/**
 * The project a resource id names, or undefined.
 *
 * Undefined for anything that is not shaped like one of Hub's: a resource id
 * loreserver invented for something other than a repository, or a repository id
 * in some other spelling. Neither is a project here, and both have to answer
 * "no" rather than "not found by accident".
 */
export function projectIdFromResourceId(resourceId: string): string | undefined {
  // Case is folded because hex is hex either way. What is not folded is the
  // string that goes back in the answer: that is echoed exactly as it arrived,
  // because loreserver compares it character by character with what it asked.
  if (!resourceId.toLowerCase().startsWith(RESOURCE_PREFIX)) {
    return undefined;
  }
  const id = resourceId.slice(RESOURCE_PREFIX.length).toLowerCase();
  return REPOSITORY_ID_PATTERN.test(id) ? id : undefined;
}

/**
 * Generate a repository id.
 *
 * A random UUID with its dashes removed: sixteen bytes, generated by the
 * caller, which is what loreserver's create call expects so that a retry of the
 * same call is the same repository rather than a second one.
 */
export function newProjectId(): string {
  return randomUUID().replaceAll("-", "");
}

function toProject(row: Row): ProjectRecord {
  return {
    id: textColumn(row, "id"),
    name: textColumn(row, "name"),
    description: textColumn(row, "description"),
    createdBy: textColumn(row, "created_by"),
    createdAt: integerColumn(row, "created_at"),
  };
}

function toGrant(row: Row): GrantRecord {
  return {
    projectId: textColumn(row, "project_id"),
    userId: textColumn(row, "user_id"),
    level: levelColumn(row, "level"),
    grantedBy: optionalTextColumn(row, "granted_by"),
    grantedAt: integerColumn(row, "granted_at"),
  };
}

const SELECT_PROJECT = "SELECT id, name, description, created_by, created_at FROM projects";
const SELECT_GRANT =
  "SELECT project_id, user_id, level, granted_by, granted_at FROM project_grants";

/** What a new project is made from. */
export interface NewProject {
  /** The repository id, from {@link newProjectId}. */
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** The account that is about to own it. */
  readonly createdBy: string;
}

/**
 * Record a project and make its creator the owner.
 *
 * Both happen in one transaction. A project row with no grant would be a
 * repository nobody — including the person who just made it — could open.
 */
export function createProject(database: DatabaseSync, input: NewProject): ProjectRecord {
  if (!PROJECT_NAME_PATTERN.test(input.name)) {
    throw new InvalidProjectNameError(input.name);
  }
  const now = Date.now();

  database.exec("BEGIN IMMEDIATE");
  try {
    database
      .prepare(
        `INSERT INTO projects (id, name, description, created_by, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.name, input.description ?? "", input.createdBy, now);
    database
      .prepare(
        `INSERT INTO project_grants (project_id, user_id, level, granted_by, granted_at)
         VALUES (?, ?, 'owner', ?, ?)`,
      )
      .run(input.id, input.createdBy, input.createdBy, now);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    // SQLite reports the collision as a constraint failure naming the column.
    // Turning it into a sentence here keeps the caller from having to read
    // SQLite's wording to tell a taken name from a broken database.
    if (error instanceof Error && error.message.includes("projects.name")) {
      throw new ProjectNameTakenError(input.name);
    }
    throw error;
  }

  return requireProject(database, input.id);
}

/** Every project, in name order. */
export function listProjects(database: DatabaseSync): ProjectRecord[] {
  return database
    .prepare(`${SELECT_PROJECT} ORDER BY name`)
    .all()
    .map((row) => toProject(row));
}

/**
 * The project with this id or this name, or undefined.
 *
 * One lookup takes either, because both are things an operator has in front of
 * them: the name they chose, and the id every log line and error message shows.
 */
export function findProject(
  database: DatabaseSync,
  reference: string,
): ProjectRecord | undefined {
  const row = database
    .prepare(`${SELECT_PROJECT} WHERE id = ? OR name = ?`)
    .get(reference.toLowerCase(), reference);
  return row === undefined ? undefined : toProject(row);
}

/** The project with this id or name, or a failure naming it. */
export function requireProject(database: DatabaseSync, reference: string): ProjectRecord {
  const project = findProject(database, reference);
  if (project === undefined) {
    throw new UnknownProjectError(reference);
  }
  return project;
}

/**
 * How far one account may go with one project, or undefined for not at all.
 *
 * This one query is what every permission question comes down to.
 */
export function accessLevel(
  database: DatabaseSync,
  projectId: string,
  userId: string,
): AccessLevel | undefined {
  const row = database
    .prepare("SELECT level FROM project_grants WHERE project_id = ? AND user_id = ?")
    .get(projectId, userId);
  return row === undefined ? undefined : levelColumn(row, "level");
}

/** Every project one account may reach, in name order. */
export function listProjectsFor(database: DatabaseSync, userId: string): ReachableProject[] {
  return database
    .prepare(
      `SELECT p.id, p.name, p.description, p.created_by, p.created_at, g.level
         FROM projects p
         JOIN project_grants g ON g.project_id = p.id
        WHERE g.user_id = ?
        ORDER BY p.name`,
    )
    .all(userId)
    .map((row) => ({ project: toProject(row), level: levelColumn(row, "level") }));
}

/** Every grant on one project, in the order they were given. */
export function listGrants(database: DatabaseSync, projectId: string): GrantRecord[] {
  return database
    .prepare(`${SELECT_GRANT} WHERE project_id = ? ORDER BY granted_at, user_id`)
    .all(projectId)
    .map((row) => toGrant(row));
}

/**
 * Give an account access to a project, or change the access it has.
 *
 * Ownership is not handed out this way: it comes from creating the project, and
 * one project has one owner. Raising a grant to `owner` would leave two, and
 * the question of which of them the project belongs to has no answer here.
 */
export function grantAccess(
  database: DatabaseSync,
  projectId: string,
  userId: string,
  level: AccessLevel,
  grantedBy: string | undefined,
): GrantRecord {
  const existing = accessLevel(database, projectId, userId);
  if (existing === "owner") {
    const project = requireProject(database, projectId);
    throw new OwnerGrantError(project.name);
  }
  database
    .prepare(
      `INSERT INTO project_grants (project_id, user_id, level, granted_by, granted_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project_id, user_id)
       DO UPDATE SET level = excluded.level,
                     granted_by = excluded.granted_by,
                     granted_at = excluded.granted_at`,
    )
    .run(projectId, userId, level, grantedBy ?? null, Date.now());

  const row = database.prepare(`${SELECT_GRANT} WHERE project_id = ? AND user_id = ?`).get(
    projectId,
    userId,
  );
  if (row === undefined) {
    throw new Error("the grant was written and could not be read back");
  }
  return toGrant(row);
}

/**
 * Take an account's access away.
 *
 * Returns false when they had none, which is not a failure: the outcome the
 * caller asked for is the outcome either way.
 */
export function revokeAccess(
  database: DatabaseSync,
  projectId: string,
  userId: string,
): boolean {
  const existing = accessLevel(database, projectId, userId);
  if (existing === undefined) {
    return false;
  }
  if (existing === "owner") {
    throw new OwnerGrantError(requireProject(database, projectId).name);
  }
  database
    .prepare("DELETE FROM project_grants WHERE project_id = ? AND user_id = ?")
    .run(projectId, userId);
  return true;
}

/**
 * Forget a project and every grant on it.
 *
 * Nothing is deleted from loreserver here. This is what happens when loreserver
 * says a repository is gone, not a way of making one go.
 */
export function forgetProject(database: DatabaseSync, projectId: string): boolean {
  const project = findProject(database, projectId);
  if (project === undefined) {
    return false;
  }
  // The grants go with it through the foreign key's ON DELETE CASCADE, which
  // only holds because the connection switches foreign keys on; see
  // src/identity/database.ts.
  database.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
  return true;
}
