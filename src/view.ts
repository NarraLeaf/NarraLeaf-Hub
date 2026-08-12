/**
 * Gathering everything the terminal interface draws, once per refresh.
 *
 * This is the half of the interface that owns the database, the certificate
 * authority and the health check. It hands over a finished
 * {@link HubView} and nothing else, which is what lets src/tui be a thing that
 * draws rather than a second implementation of the rules.
 *
 * What Hub cannot work out is left out, not guessed at. A project's revision
 * history and the file inside it belong to loreserver's repository, which Hub
 * does not open — it is served by a process holding an exclusive lock on it,
 * and a second reader would wait for ever. Those fields therefore arrive
 * absent and are drawn as "unknown", which is the same thing the interface
 * does with a project written by a newer Studio.
 */
import { stat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describeDuration } from "./duration.js";
import { audienceHosts, authUrl, dataRemoteUrl, type IdentityConfig } from "./identity/config.js";
import { listInvites } from "./identity/invites.js";
import { KeyStore } from "./identity/keys.js";
import { identityLayout } from "./identity/layout.js";
import { storedTokenLifetimes } from "./identity/settings.js";
import { findUserById, listUsers } from "./identity/users.js";
import { checkHealth } from "./loreserver/health.js";
import { instanceLayout } from "./loreserver/layout.js";
import { LORESERVER_VERSION, resolveArtifact } from "./loreserver/pin.js";
import { listGrants, listProjects, listProjectsFor } from "./projects/registry.js";
import type {
  HubView,
  ProjectView,
  SettingView,
  UserView,
} from "./tui/hubview.js";
import { VERSION } from "./version.js";

import type { DatabaseSync } from "node:sqlite";

/** What a view is gathered from. */
export interface ViewContext {
  readonly root: string;
  readonly database: DatabaseSync;
  readonly config: IdentityConfig;
  readonly healthPort: number;
  /** The fingerprint of this Hub's authority, absent until one exists. */
  readonly fingerprint: string | undefined;
}

/**
 * How many files a storage measurement will stat before giving up on it.
 *
 * A size is worth having and not worth waiting for: past this the view says
 * "unknown" rather than holding up the screen while it walks a store with
 * half a million objects in it.
 */
const STORAGE_FILE_LIMIT = 50_000;

/**
 * The labels of the two rows Hub has somewhere to write.
 *
 * Named here rather than typed twice, because the settings surface finds a row
 * by its position and the writer finds it by its label; two spellings of the
 * same string would put a new value in the wrong place.
 */
export const SIGN_IN_SETTING = "sign-in token";
export const REPOSITORY_SETTING = "repository token";

/** The word for a value Hub has but cannot show. */
const UNKNOWN_FINGERPRINT = "unknown";

/**
 * Add up what a directory holds.
 *
 * Returns nothing rather than a number it is not sure of: a partial total
 * looks exactly like a real one, and a store that shrank by half would be read
 * as a store that lost half its objects.
 */
export async function directoryBytes(path: string): Promise<number | undefined> {
  try {
    const entries = await readdir(path, { recursive: true, withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile());
    if (files.length > STORAGE_FILE_LIMIT) {
      return undefined;
    }
    let total = 0;
    for (const file of files) {
      const stats = await stat(join(file.parentPath, file.name));
      total += stats.size;
    }
    return total;
  } catch {
    return undefined;
  }
}

/** The name loreserver's executable has here, which decides none of the paths read below. */
function binaryName(): string {
  try {
    return resolveArtifact().binaryName;
  } catch {
    // A machine with no pinned build still has a storage root, and the name of
    // an executable it will never run is not what this is reading.
    return "loreserver";
  }
}

/** Where loreserver keeps what it holds, under one storage root. */
export function storageRootOf(root: string): string {
  return dirname(instanceLayout(root, binaryName()).immutableStoreDir);
}

function userView(database: DatabaseSync, user: ReturnType<typeof listUsers>[number]): UserView {
  return {
    username: user.username,
    displayName: user.displayName,
    ...(user.email === undefined ? {} : { email: user.email }),
    role: user.groups.length === 0 ? "none" : user.groups.join(","),
    disabled: user.disabledAt !== undefined,
    serviceAccount: user.isServiceAccount,
    createdAt: user.createdAt,
    // When somebody was last seen, and when their tokens were last refused,
    // are not written down: the accounts table keeps a counter rather than a
    // moment. Absent is what the interface draws as unknown.
    projects: listProjectsFor(database, user.id).map((reachable) => ({
      name: reachable.project.name,
      level: reachable.level,
    })),
  };
}

function projectView(database: DatabaseSync, project: ReturnType<typeof listProjects>[number]): ProjectView {
  const nameOf = (id: string): string => findUserById(database, id)?.username ?? "unknown";
  return {
    name: project.name,
    description: project.description,
    owner: nameOf(project.createdBy),
    createdAt: project.createdAt,
    access: listGrants(database, project.id).map((grant) => ({
      username: nameOf(grant.userId),
      level: grant.level,
    })),
    // Everything below here lives inside the repository loreserver serves,
    // which Hub does not open. Nothing is stated rather than guessed: an
    // empty history draws as unknown, and a project that has been worked on
    // for months does not read as one nobody has touched.
    history: {},
    file: {
      readable: false,
      reason: "the project file is inside loreserver's repository, which Hub does not open",
    },
  };
}

/**
 * The settings surface, and the one place that decides what may be changed
 * from it.
 *
 * A row is editable only where Hub has somewhere to put the new value. The
 * identity settings and the ports are named on the command line that started
 * `up`, so they are shown and marked read-only: an editor over a value that
 * would be thrown away is worse than no editor, because it looks like it
 * worked.
 */
export function settingRows(context: ViewContext): SettingView[] {
  const lifetimes = storedTokenLifetimes(context.database);
  const storageRoot = storageRootOf(context.root);
  const { config } = context;
  return [
    {
      group: "tokens",
      label: SIGN_IN_SETTING,
      value: describeDuration(lifetimes.signInTokenLifetimeSeconds),
      editable: true,
    },
    {
      group: "tokens",
      label: REPOSITORY_SETTING,
      value: describeDuration(lifetimes.repositoryTokenLifetimeSeconds),
      editable: true,
      caution:
        "loreserver accepts this one without asking Hub, so revoking access cannot cut it short.",
    },
    { group: "identity", label: "issuer", value: config.issuer, editable: false },
    { group: "identity", label: "audience", value: config.audience, editable: false },
    {
      group: "identity",
      label: "hostnames",
      value: audienceHosts(config).join(", "),
      editable: false,
    },
    { group: "loreserver", label: "pinned version", value: LORESERVER_VERSION, editable: false },
    {
      group: "loreserver",
      label: "data port",
      value: String(config.dataPort),
      editable: false,
    },
    { group: "loreserver", label: "storage root", value: storageRoot, editable: false },
    {
      group: "authority",
      label: "fingerprint",
      value: context.fingerprint ?? UNKNOWN_FINGERPRINT,
      editable: false,
    },
  ];
}

/** Read everything the interface draws, and answer with it. */
export async function gatherHubView(context: ViewContext): Promise<HubView> {
  const { database, config } = context;
  const identity = identityLayout(context.root);
  const storageRoot = storageRootOf(context.root);

  const healthy = await checkHealth(context.healthPort);
  const now = Date.now();
  const storageBytes = await directoryBytes(storageRoot);

  let signingKeys = 0;
  try {
    signingKeys = (await KeyStore.open(identity.keysDir)).published.length;
  } catch {
    // A Hub that has not run `up` yet has no keys directory. Nought is the
    // truth about it, not a failure to read one.
  }

  const invitesLive = listInvites(database).filter(
    (invite) => invite.usedAt === undefined && invite.expiresAt > now,
  ).length;

  return {
    hubVersion: VERSION,
    root: identity.root,
    now,
    server: {
      version: LORESERVER_VERSION,
      // From outside the process that supervises it, a loreserver that does
      // not answer its health check cannot be told from one that is not
      // running, and the pid, the start and the restarts belong to that
      // process. What is here is what a second program can see.
      running: healthy,
      restarts: 0,
      healthy,
      healthCheckedAt: now,
      ...(storageBytes === undefined ? {} : { storageBytes }),
      storageRoot,
    },
    reach: {
      signIn: authUrl(config),
      data: dataRemoteUrl(audienceHosts(config)[0] ?? "127.0.0.1", config.dataPort),
      fingerprint: context.fingerprint ?? UNKNOWN_FINGERPRINT,
      loopback: [
        { port: context.healthPort, what: "health" },
        { port: config.hubPort, what: "jwks" },
        { port: config.authPort, what: "authz" },
      ],
    },
    users: listUsers(database).map((user) => userView(database, user)),
    projects: listProjects(database).map((project) => projectView(database, project)),
    // Every decision Hub makes is written to the log of the `up` process that
    // made it, and nowhere else. Until Hub keeps them, this is empty rather
    // than filled with something that resembles them.
    audit: [],
    settings: settingRows(context),
    invitesLive,
    signingKeys,
  };
}
