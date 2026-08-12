/**
 * The `project` commands: make a repository, see who can reach one, and change
 * who can.
 *
 * `project create` is the only one that talks to loreserver. The rest are rows
 * in Hub's database, and they take effect on the next thing anybody does:
 * loreserver asks Hub about every repository access, so a grant added here is
 * in force immediately and a revocation is too, without a restart on either
 * side and without waiting for a token to expire.
 */
import type { DatabaseSync } from "node:sqlite";

import type { WriteText } from "./cli.js";
import { identityConfig, type IdentityConfig } from "./identity/config.js";
import { openMigratedDatabase } from "./identity/database.js";
import { KeyStore } from "./identity/keys.js";
import { identityLayout } from "./identity/layout.js";
import { storedTokenLifetimes } from "./identity/settings.js";
import { mintToken } from "./identity/tokens.js";
import { countUsers, listUsers, requireUser, type UserRecord } from "./identity/users.js";
import { loreserverUrl, repositoryCreate } from "./projects/repository.js";
import {
  createProject,
  forgetProject,
  grantAccess,
  listGrants,
  listProjects,
  listProjectsFor,
  newProjectId,
  requireProject,
  revokeAccess,
  type AccessLevel,
} from "./projects/registry.js";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ProjectCreateOptions {
  readonly root: string;
  readonly name: string;
  readonly description: string | undefined;
  /** The account the project is created for and belongs to. */
  readonly as: string | undefined;
  /** The port loreserver serves gRPC on. */
  readonly dataPort: number;
  readonly overrides: Partial<IdentityConfig>;
}

export interface ProjectListOptions {
  readonly root: string;
  /** Whose view to take. Absent for the operator's, which is everything. */
  readonly as: string | undefined;
}

export interface ProjectGrantOptions {
  readonly root: string;
  /** A project name or a repository id. */
  readonly project: string;
  readonly username: string;
  readonly level: AccessLevel;
}

export interface ProjectRevokeOptions {
  readonly root: string;
  readonly project: string;
  readonly username: string;
}

/**
 * The account a command is acting for.
 *
 * A Hub with one account has no ambiguity to resolve, and naming yourself on
 * every command would be ceremony. With two, there is no such thing as the
 * obvious one, so the command says so rather than choosing.
 */
function resolveOperator(database: DatabaseSync, username: string | undefined): UserRecord {
  if (username !== undefined) {
    return requireUser(database, username);
  }
  const accounts = countUsers(database);
  if (accounts === 0) {
    throw new Error("this Hub has no accounts yet. Run up to be given an invite code for one.");
  }
  const only = listUsers(database)[0];
  if (accounts > 1 || only === undefined) {
    throw new Error(
      "there is more than one account here, so name the one this is for with --as <username>",
    );
  }
  return only;
}

/**
 * Create a repository on loreserver and record the project it belongs to.
 *
 * The row is written first and removed again if loreserver refuses. That order
 * matters: loreserver announces the new repository back to Hub while the create
 * call is still open, and a Hub that had not recorded the project yet would
 * have nothing to say about it.
 */
export async function projectCreate(
  options: ProjectCreateOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  const database = await openMigratedDatabase(layout.databasePath);

  try {
    // Defaults, then what this Hub has stored, then what the command line
    // named. That order is what makes --token-lifetime an override for the run
    // rather than a value a stored setting could quietly beat.
    const config = identityConfig({ ...storedTokenLifetimes(database), ...options.overrides });
    const owner = resolveOperator(database, options.as);
    const keys = await KeyStore.open(layout.keysDir);
    // Minted without a password, unlike `token mint`. Whoever runs this already
    // has the storage root and could sign anything they liked with the key in
    // it; a prompt here would be a formality, not a check.
    //
    // The repository lifetime and not the sign-in one: this token is handed
    // straight to loreserver for a single create call and then dropped, and a
    // token that outlives its one use by a month is one to be found later.
    const minted = mintToken(owner, keys.signingKey, config, { purpose: "repository" });

    const id = newProjectId();
    const project = createProject(database, {
      id,
      name: options.name,
      ...(options.description === undefined ? {} : { description: options.description }),
      createdBy: owner.id,
    });

    let repository;
    try {
      repository = await repositoryCreate({
        url: loreserverUrl(options.dataPort),
        token: minted.token,
        id: project.id,
        name: project.name,
        description: project.description,
      });
    } catch (error) {
      forgetProject(database, project.id);
      throw error;
    }

    stdout(`created ${repository.name}\n`);
    stdout(`repository ${repository.id}\n`);
    stdout(`owner ${owner.username}\n`);
    stdout(`default branch ${repository.defaultBranchName}\n`);
    return 0;
  } catch (error) {
    stderr(`nlhub: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}

/** Every project, or every project one person can reach. */
export async function projectList(
  options: ProjectListOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  const database = await openMigratedDatabase(layout.databasePath);

  try {
    if (options.as !== undefined) {
      const user = requireUser(database, options.as);
      const reachable = listProjectsFor(database, user.id);
      if (reachable.length === 0) {
        stdout(`${user.username} can reach no projects here.\n`);
        return 0;
      }
      const width = Math.max(...reachable.map((entry) => entry.project.name.length));
      for (const entry of reachable) {
        const name = entry.project.name.padEnd(width);
        stdout(`${name}  ${entry.level.padEnd(5)}  ${entry.project.id}\n`);
      }
      return 0;
    }

    const projects = listProjects(database);
    if (projects.length === 0) {
      stdout("no projects yet. Make one with project create <name>.\n");
      return 0;
    }
    const names = new Map(listUsers(database).map((user) => [user.id, user.username]));
    const width = Math.max(...projects.map((project) => project.name.length));
    for (const project of projects) {
      const owner = names.get(project.createdBy) ?? project.createdBy;
      // Everyone with a grant, the owner included, so that one line says who
      // can open this repository.
      const people = listGrants(database, project.id)
        .map((grant) => `${names.get(grant.userId) ?? grant.userId}:${grant.level}`)
        .join(",");
      stdout(`${project.name.padEnd(width)}  ${project.id}  ${owner}  ${people}\n`);
    }
    return 0;
  } catch (error) {
    stderr(`nlhub: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}

/** Let an account reach a project. */
export async function projectGrant(
  options: ProjectGrantOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  const database = await openMigratedDatabase(layout.databasePath);

  try {
    const project = requireProject(database, options.project);
    const user = requireUser(database, options.username);
    // No `granted_by`: a grant made on the command line was made by whoever
    // holds the storage root, and that is not an account.
    const grant = grantAccess(database, project.id, user.id, options.level, undefined);

    stdout(`${user.username} may ${grant.level} ${project.name}\n`);
    return 0;
  } catch (error) {
    stderr(`nlhub: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}

/** Stop an account reaching a project. */
export async function projectRevoke(
  options: ProjectRevokeOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  const database = await openMigratedDatabase(layout.databasePath);

  try {
    const project = requireProject(database, options.project);
    const user = requireUser(database, options.username);
    const had = revokeAccess(database, project.id, user.id);

    stdout(
      had
        ? `${user.username} can no longer reach ${project.name}\n`
        : `${user.username} could not reach ${project.name} anyway\n`,
    );
    // Said because it is the opposite of what taking a token away would do: the
    // next access is refused, whatever token the person is holding.
    if (had) {
      stdout("The next repository access they attempt is refused.\n");
    }
    return 0;
  } catch (error) {
    stderr(`nlhub: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}
