/**
 * The command behind a bare `nlteam`: open the terminal interface on a storage
 * root.
 *
 * Everything the interface asks for is carried out by src/actions.ts, which
 * calls what the command of the same name calls: `d` reaches `disableUser`,
 * `x` reaches `revokeUserTokens`, `k` reaches `KeyStore.rotate`. None of it is
 * implemented twice, and what each one answers with says the same thing the
 * command prints — including how far it reaches, which is the part an operator
 * gets wrong. The web interface is handed the same function.
 */
import { perform } from "./actions.js";
import type { WriteText } from "./cli.js";
import type { IdentityConfig } from "./identity/config.js";
import { openMigratedDatabase } from "./identity/database.js";
import { identityLayout } from "./identity/layout.js";
import { prepareLoreEnvironment } from "./lore/environment.js";
import { ViewPublisher } from "./publisher.js";
import { runInterface } from "./tui/run.js";
import { readAuthority } from "./tls/authority.js";

import type { DatabaseSync } from "node:sqlite";

// Where it used to live. The tests that reach for it are testing what an
// operator may type into the setting editor, which is a rule about this
// interface however it is spelled.
export { readDuration } from "./actions.js";

export interface InterfaceOptions {
  readonly root: string;
  readonly healthPort: number;
  readonly config: IdentityConfig;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  }

  try {
    // A Team server that has not been brought up yet has no authority, which is a
    // thing to say on screen rather than a reason to refuse to draw one.
    let fingerprint: string | undefined;
    try {
      fingerprint = (await readAuthority(options.root)).fingerprint256;
    } catch {
      fingerprint = undefined;
    }

    // Before the reader below exists, for the reason src/lore/environment.ts
    // sets out. This command reaches the same repositories `up` does and is not
    // reached through it, so settling that environment in `up` alone would
    // leave the interface reading as somebody else's session.
    //
    // Nothing is printed about it. A root with no authority yet is drawn as a
    // server that has not been brought up, which this interface already says
    // better than a line above the screen would.
    prepareLoreEnvironment(options.root);

    // What is inside a repository is read over the network, so it is read
    // beside the interface rather than in front of it: the first view is
    // gathered from the database and drawn at once, and each project's history
    // and file replace the word unknown as it arrives.
    const publisher = new ViewPublisher({
      root: layout.root,
      database,
      config: options.config,
      healthPort: options.healthPort,
      fingerprint,
    });

    publisher.start();
    try {
      await runInterface(await publisher.gather(), {
        refresh: () => {
          publisher.request();
          return publisher.gather();
        },
        // The sentence, which is the whole of what this interface shows. An
        // action that also produced a credential has nowhere to put one here:
        // the two the operator's page uses for that are not on any key.
        perform: async (action) => (await perform(publisher.context, action)).message,
        subscribe: (listen) => publisher.subscribe(listen),
      });
    } finally {
      publisher.stop();
    }
    return 0;
  } catch (error) {
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}
