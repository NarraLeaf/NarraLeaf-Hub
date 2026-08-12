/**
 * The `up` command: from nothing to a running, healthy loreserver, with Hub's
 * own endpoint beside it.
 *
 * Every step announces itself, because the first one can take a minute on a
 * slow connection and a silent program is indistinguishable from a stuck one.
 */
import type { DatabaseSync } from "node:sqlite";

import type { WriteText } from "./cli.js";
import { authUrl, identityConfig, jwksUrl, type IdentityConfig } from "./identity/config.js";
import { openMigratedDatabase } from "./identity/database.js";
import { IdentityEndpoint } from "./identity/endpoint.js";
import { createInvite, withdrawUnusedBootstrapInvites } from "./identity/invites.js";
import { KeyStore } from "./identity/keys.js";
import { identityLayout } from "./identity/layout.js";
import { countUsers } from "./identity/users.js";
import { renderInvite } from "./invite.js";
import { waitForHealth, healthCheckUrl } from "./loreserver/health.js";
import { verifyBinaryDigest, verifyBinaryVersion } from "./loreserver/identify.js";
import { ensureInstalled } from "./loreserver/install.js";
import {
  instanceLayout,
  writeInstance,
  type LoreserverAuth,
  type LoreserverPorts,
} from "./loreserver/layout.js";
import { LORESERVER_VERSION, resolveArtifact } from "./loreserver/pin.js";
import { Supervisor, describeExit } from "./loreserver/supervisor.js";
import { VERSION } from "./version.js";

export interface UpOptions extends LoreserverPorts {
  /** The storage root; everything Hub writes goes underneath it. */
  readonly root: string;
  /**
   * True to configure loreserver to demand a Hub token. Without it the server
   * asks nobody who they are, which is what it did before Hub could issue
   * tokens at all.
   */
  readonly identity?: boolean;
  /** Identity settings an operator named; the rest keep their defaults. */
  readonly overrides?: Partial<IdentityConfig>;
  /**
   * Aborted to bring the command down. Without one, `up` runs until
   * loreserver can no longer be kept alive.
   */
  readonly signal?: AbortSignal;
}

/**
 * How long the code printed for a Hub with no accounts lasts.
 *
 * A day: long enough that an operator who started the server and walked away
 * can still use it, short enough that one left in a terminal's scrollback is
 * not a way in a week later.
 */
const BOOTSTRAP_INVITE_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** The group the first account joins. */
const BOOTSTRAP_ROLE = "admin";

/** A promise that settles when the signal is aborted, and never otherwise. */
function whenAborted(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) {
    return new Promise<void>(() => {});
  }
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What loreserver has to be told when identity is switched on. */
function loreserverAuth(config: IdentityConfig): LoreserverAuth {
  return {
    issuer: config.issuer,
    // One entry: this is the audience loreserver requires, not the whole of
    // what a token carries. A token is accepted when its `aud` array holds it.
    audience: [config.audience],
    jwksUrl: jwksUrl(config.hubPort),
    authUrl: authUrl(config),
  };
}

/**
 * Install, configure, start and supervise loreserver, then wait.
 *
 * Returns the process exit code.
 */
export async function up(
  options: UpOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const ports: LoreserverPorts = {
    dataPort: options.dataPort,
    healthPort: options.healthPort,
  };
  const config = identityConfig(options.overrides ?? {});
  const identity = identityLayout(options.root);

  let supervisor: Supervisor | undefined;
  let endpoint: IdentityEndpoint | undefined;
  let database: DatabaseSync | undefined;

  try {
    const artifact = resolveArtifact();
    const layout = instanceLayout(options.root, artifact.binaryName);
    stdout(`loreserver ${LORESERVER_VERSION} for ${artifact.target}\n`);
    if (artifact.caveat !== undefined) {
      stdout(`note: ${artifact.caveat}\n`);
    }
    stdout(`storage root ${layout.root}\n`);

    // Identity comes up first: it is quick, and a port already taken is worth
    // discovering before a download rather than after one.
    database = await openMigratedDatabase(identity.databasePath);
    const keys = await KeyStore.open(identity.keysDir);
    endpoint = await IdentityEndpoint.start({
      port: config.hubPort,
      // The keys directory is read again on every request, so that a
      // `nlhub key rotate` in another terminal is published without this
      // process being restarted. It is a handful of small files, and the
      // document is fetched rarely.
      jwks: async () => {
        await keys.reload();
        return keys.jwks();
      },
      version: VERSION,
    });
    stdout(`identity endpoint on ${endpoint.url}, signing with ${keys.signingKey.kid}\n`);

    await ensureInstalled(layout, artifact, {
      onAlreadyInstalled: (path) => stdout(`already installed at ${path}\n`),
      onFetching: (url) => stdout(`fetching ${url}\n`),
      onVerifying: (bytes) =>
        stdout(`verifying ${bytes.toLocaleString("en-US")} bytes against the pinned checksum\n`),
      onExtracting: (binDir) => stdout(`extracting into ${binDir}\n`),
    });

    // Both checks run on every start, including one that installed nothing:
    // the archive digest says what was downloaded, which is not the same as
    // what is on disk now.
    await verifyBinaryDigest(layout.binaryPath, artifact.binarySha256);
    const reported = await verifyBinaryVersion(layout.binaryPath, LORESERVER_VERSION);
    stdout(`verified ${layout.binaryPath} is loreserver ${reported}, matching its pinned checksum\n`);

    const auth = options.identity === true ? loreserverAuth(config) : undefined;
    await writeInstance(layout, ports, auth);
    stdout(`wrote ${layout.configPath}\n`);
    if (auth === undefined) {
      stdout("loreserver will accept any client: pass --identity to make it demand a token\n");
    } else {
      stdout(`loreserver will demand a token from ${auth.issuer} for ${auth.audience[0]}\n`);
    }

    // Only a failure that ends supervision should cut the health wait short; a
    // single early exit is followed by a restart and may still come good.
    let supervisionError: Error | undefined;

    supervisor = new Supervisor({
      name: "loreserver",
      command: layout.binaryPath,
      args: ["--config", layout.configDir],
      logPath: layout.logPath,
      onEvent: (event) => {
        switch (event.kind) {
          case "started":
            stdout(`started loreserver, pid ${event.pid}\n`);
            break;
          case "exited":
            if (!event.deliberate) {
              stderr(`nlhub: loreserver exited: ${describeExit(event.code, event.signal)}\n`);
            }
            break;
          case "restarting":
            stderr(
              `nlhub: restarting loreserver in ${(event.delayMs / 1000).toFixed(2)}s ` +
                `after ${event.consecutiveFailures} failure(s)\n`,
            );
            break;
          case "gave-up":
            supervisionError = event.error;
            break;
        }
      },
    });

    stdout(`logging to ${layout.logPath}\n`);
    await supervisor.start();

    const elapsedMs = await waitForHealth(ports.healthPort, {
      abandonReason: () => supervisionError?.message,
    });
    stdout(
      `healthy after ${(elapsedMs / 1000).toFixed(1)}s: ${healthCheckUrl(ports.healthPort)}\n`,
    );
    stdout(`gRPC and QUIC on port ${ports.dataPort}\n`);

    // Last, so that it is the thing left on the screen rather than something
    // scrolled away by a download.
    printBootstrapInvite(database, identity.root, stdout);

    stdout("press Ctrl-C to stop\n");

    // Whichever comes first: the operator interrupting, or supervision ending.
    const failure = await Promise.race([
      supervisor.failed,
      whenAborted(options.signal).then(() => undefined),
    ]);

    await supervisor.stop();

    if (failure !== undefined) {
      stderr(`nlhub: ${failure.message}\n`);
      return 1;
    }
    stdout("stopped loreserver\n");
    return 0;
  } catch (error) {
    // Anything raised after the child was spawned still has to take it down;
    // leaving a loreserver behind after a failed `up` would be worse than the
    // failure itself.
    if (supervisor !== undefined) {
      await supervisor.stop();
    }
    stderr(`nlhub: ${describeError(error)}\n`);
    return 1;
  } finally {
    // The endpoint holds a listening socket and the database a file handle;
    // either would keep the process alive after the work is over.
    if (endpoint !== undefined) {
      await endpoint.close();
    }
    database?.close();
  }
}

/**
 * Print a code for the first account, if there is no account yet.
 *
 * A fresh code is made on every start that finds an empty Hub, because Hub
 * cannot reprint the previous one — it only ever held its hash. Any earlier
 * unused one is withdrawn at the same time, so exactly one code is live rather
 * than one per start. Once an account exists, nothing is printed again.
 */
function printBootstrapInvite(
  database: DatabaseSync,
  root: string,
  stdout: WriteText,
): void {
  if (countUsers(database) > 0) {
    return;
  }
  withdrawUnusedBootstrapInvites(database);
  const { code, invite } = createInvite(database, {
    role: BOOTSTRAP_ROLE,
    lifetimeMs: BOOTSTRAP_INVITE_LIFETIME_MS,
    isBootstrap: true,
  });

  stdout("\n");
  stdout("This Hub has no accounts. Make the first one with this invite code:\n");
  stdout(renderInvite(code, invite.role, invite.expiresAt, root));
}
