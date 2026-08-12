/**
 * The command behind a bare `nlhub`: open the terminal interface on a storage
 * root.
 *
 * Everything the interface asks for is carried out here, by calling what the
 * command of the same name calls: `d` reaches `disableUser`, `x` reaches
 * `revokeUserTokens`, `i` reaches `createInvite`. None of it is implemented
 * twice, and what each one answers with says the same thing the command
 * prints — including how far it reaches, which is the part an operator gets
 * wrong.
 */
import { parseDuration } from "./args.js";
import type { WriteText } from "./cli.js";
import { describeDuration } from "./duration.js";
import type { IdentityConfig } from "./identity/config.js";
import { openMigratedDatabase } from "./identity/database.js";
import { createInvite, DEFAULT_INVITE_LIFETIME_MS, DEFAULT_ROLE } from "./identity/invites.js";
import { KeyStore } from "./identity/keys.js";
import { identityLayout } from "./identity/layout.js";
import { setTokenLifetimes, storedTokenLifetimes } from "./identity/settings.js";
import { disableUser, enableUser, revokeUserTokens } from "./identity/users.js";
import { ProjectReadings } from "./projects/refresh.js";
import type { HubView } from "./tui/hubview.js";
import { runInterface } from "./tui/run.js";
import type { Action } from "./tui/state.js";
import { readAuthority } from "./tls/authority.js";
import {
  gatherHubView,
  settingRows,
  REPOSITORY_SETTING,
  SIGN_IN_SETTING,
  type ViewContext,
} from "./view.js";

import type { DatabaseSync } from "node:sqlite";

export interface InterfaceOptions {
  readonly root: string;
  readonly healthPort: number;
  readonly config: IdentityConfig;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * How long a redraw waits for more readings before it happens.
 *
 * Short enough that a project appearing feels immediate, long enough that a
 * pass over several of them costs one redraw rather than one each.
 */
const PUBLISH_DELAY_MS = 200;

/**
 * Read a duration the way it was written on screen.
 *
 * The editor opens on the words a person reads — "30 days" — so those words
 * have to be accepted back. `7d` is accepted as well, because it is what every
 * command line here takes, and somebody who knows one spelling should not have
 * to discover the other.
 */
export function readDuration(text: string): number | string {
  const written = text
    .trim()
    .toLowerCase()
    .replace(/\s*(day|hour|minute|second)s?$/, (_match, unit: string) => unit.slice(0, 1))
    .replace(/\s+/g, "");
  const milliseconds = parseDuration("the value", written);
  return typeof milliseconds === "string" ? milliseconds : Math.floor(milliseconds / 1000);
}

/** What the interface is told after somebody's tokens were refused. */
function revokedMessage(database: DatabaseSync, username: string): string {
  const lifetimes = storedTokenLifetimes(database);
  // The same two facts `nlhub user revoke-tokens` prints, for the same reason:
  // "every token" is read as including a session somebody has open, and it
  // does not.
  return (
    `revoked the tokens of ${username}; a connection already open may last until its ` +
    `repository token expires, at most ${describeDuration(
      lifetimes.repositoryTokenLifetimeSeconds,
    )} from now`
  );
}

/** Change one setting, and say what it now is. */
function writeSetting(context: ViewContext, index: number, value: string): string {
  const row = settingRows(context)[index];
  if (row === undefined || !row.editable) {
    return "that row is read only";
  }
  const seconds = readDuration(value);
  if (typeof seconds === "string") {
    return seconds;
  }
  const lifetimes = setTokenLifetimes(
    context.database,
    row.label === SIGN_IN_SETTING
      ? { signInTokenLifetimeSeconds: seconds }
      : { repositoryTokenLifetimeSeconds: seconds },
  );
  const now =
    row.label === SIGN_IN_SETTING
      ? lifetimes.signInTokenLifetimeSeconds
      : lifetimes.repositoryTokenLifetimeSeconds;
  return `${row.label} is ${describeDuration(now)}; tokens already minted keep the lifetime they were given`;
}

/**
 * Carry out one thing the interface asked for.
 *
 * The three that name a command rather than doing anything are the three that
 * need something the interface has no way to ask for — a project's name, an
 * account to grant to, a process it does not supervise. Naming the command is
 * the honest answer; opening a window that pretended to do it would not be.
 */
async function perform(context: ViewContext, action: Action): Promise<string> {
  const { database, root } = context;
  switch (action.kind) {
    case "create-invite": {
      const { code, invite } = createInvite(database, {});
      return `invite ${code} · joins ${DEFAULT_ROLE} · good for ${describeDuration(
        DEFAULT_INVITE_LIFETIME_MS / 1000,
      )}, and shown once`;
    }
    case "rotate-key": {
      const keys = await KeyStore.open(identityLayout(root).keysDir);
      const key = await keys.rotate();
      return `signing with ${key.kid}; tokens signed by any of the ${keys.published.length} published keys still verify`;
    }
    case "set-user-disabled": {
      if (action.disabled) {
        disableUser(database, action.username);
        return `disabled ${action.username}; nothing new is issued and tokens already issued are refused from now on`;
      }
      enableUser(database, action.username);
      return `enabled ${action.username}`;
    }
    case "revoke-tokens": {
      revokeUserTokens(database, action.username);
      return revokedMessage(database, action.username);
    }
    case "set-setting":
      return writeSetting(context, action.index, action.value);
    case "new-project":
      return `a project needs a name: nlhub project create <name> --root ${root}`;
    case "grant-access":
      return `nlhub project grant ${action.project} <username> --root ${root} --level read`;
    case "revoke-access":
      return `nlhub project revoke ${action.project} <username> --root ${root}`;
    case "restart-loreserver":
      return "loreserver belongs to the nlhub up that started it; stop and start that";
    case "quit":
    case "refresh":
      // Neither reaches here: the interface acts on both itself.
      return "";
  }
}

/**
 * Open the interface on a storage root. Returns the process exit code.
 *
 * The database is opened once and closed on the way out, however the interface
 * ended: a handle left open outlives the screen it was for.
 */
export async function terminalInterface(
  options: InterfaceOptions,
  _stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  let database: DatabaseSync;
  try {
    database = await openMigratedDatabase(layout.databasePath);
  } catch (error) {
    stderr(`nlhub: ${describeError(error)}\n`);
    return 1;
  }

  try {
    // A Hub that has not been brought up yet has no authority, which is a
    // thing to say on screen rather than a reason to refuse to draw one.
    let fingerprint: string | undefined;
    try {
      fingerprint = (await readAuthority(options.root)).fingerprint256;
    } catch {
      fingerprint = undefined;
    }

    // What is inside a repository is read over the network, so it is read
    // beside the interface rather than in front of it: the first view is
    // gathered from the database and drawn at once, and each project's history
    // and file replace the word unknown as it arrives.
    const listeners = new Set<(view: HubView) => void>();
    const readings = new ProjectReadings({
      root: layout.root,
      database,
      config: options.config,
      onChange: () => publish(),
    });

    const context: ViewContext = {
      root: layout.root,
      database,
      config: options.config,
      healthPort: options.healthPort,
      fingerprint,
      readings,
    };

    /**
     * Gather a view and hand it to whoever is drawing.
     *
     * Coalesced, and that matters: a pass reads every project in turn, and
     * gathering measures the whole storage root each time. One gather per short
     * window turns a Hub with forty projects from forty walks of the store into
     * a handful, and the screen still fills in as the readings land.
     */
    let scheduled: NodeJS.Timeout | undefined;
    const publish = (): void => {
      if (scheduled !== undefined) {
        return;
      }
      scheduled = setTimeout(() => {
        scheduled = undefined;
        void gatherHubView(context)
          .then((view) => {
            for (const listener of listeners) {
              listener(view);
            }
          })
          .catch(() => {
            // Nothing is written anywhere from here: the interface owns the
            // alternate screen, and a line on stderr in the middle of it is
            // rubbish across whatever was drawn. A gather that failed is a
            // screen that stays as it was, and the next reading tries again.
          });
      }, PUBLISH_DELAY_MS);
      // Nothing should be held open by a redraw that has not happened yet.
      scheduled.unref();
    };

    readings.start();
    try {
      await runInterface(await gatherHubView(context), {
        refresh: () => {
          // Somebody asking for a refresh means the repositories too, and
          // waiting for them is exactly what this must not do.
          readings.request();
          return gatherHubView(context);
        },
        perform: (action) => perform(context, action),
        subscribe: (listen) => {
          listeners.add(listen);
          return () => {
            listeners.delete(listen);
          };
        },
      });
    } finally {
      readings.stop();
      if (scheduled !== undefined) {
        clearTimeout(scheduled);
      }
    }
    return 0;
  } catch (error) {
    stderr(`nlhub: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}
