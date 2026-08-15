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
        perform: (action) => perform(publisher.context, action),
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
