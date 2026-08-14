/**
 * The `up` command: from nothing to a running, healthy loreserver, with Team's
 * own endpoint beside it.
 *
 * Every step announces itself, because the first one can take a minute on a
 * slow connection and a silent program is indistinguishable from a stuck one.
 */
import type { DatabaseSync } from "node:sqlite";

import type { WriteText } from "./cli.js";
import type { GrpcServer } from "./grpc/server.js";
import {
  audienceHosts,
  authUrl,
  dataRemoteUrl,
  hostOf,
  identityConfig,
  jwksUrl,
  type IdentityConfig,
} from "./identity/config.js";
import { openMigratedDatabase } from "./identity/database.js";
import { serveDiscovery } from "./identity/discovery.js";
import { IdentityEndpoint } from "./identity/endpoint.js";
import { createInvite, withdrawUnusedBootstrapInvites } from "./identity/invites.js";
import { KeyStore } from "./identity/keys.js";
import { identityLayout } from "./identity/layout.js";
import { namedTokenLifetimes } from "./identity/settings.js";
import { countUsers } from "./identity/users.js";
import { renderInvite } from "./invite.js";
import {
  ensureLorelibNotices,
  LORELIB_VERSION,
  resolveLorelibArtifact,
} from "./lore/pin.js";
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
import { startAuthorizationService } from "./projects/service.js";
import { ensureCertificates, type TeamAuthority } from "./tls/authority.js";
import { trustCommandFor } from "./tls/trust.js";
import { VERSION } from "./version.js";

export interface UpOptions extends LoreserverPorts {
  /** The storage root; everything Team writes goes underneath it. */
  readonly root: string;
  /**
   * True to configure loreserver to demand a Team server token. Without it the server
   * asks nobody who they are, which is what it did before Team could issue
   * tokens at all.
   */
  readonly identity?: boolean;
  /**
   * Identity settings an operator named; the rest keep their defaults.
   *
   * `hostnames` among them: the names people reach this Team server by go into the auth
   * endpoint's certificate and into every token's audience, and taking both
   * from one setting is what stops a Team server whose certificate names a host issuing
   * tokens that do not.
   */
  readonly overrides?: Partial<IdentityConfig>;
  /**
   * Aborted to bring the command down. Without one, `up` runs until
   * loreserver can no longer be kept alive.
   */
  readonly signal?: AbortSignal;
}

/**
 * How long the code printed for a Team server with no accounts lasts.
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

/**
 * The environment that lets loreserver reach Team's https auth endpoint.
 *
 * `auth_url` serves two callers at once. It is where a client is told to sign
 * in, so it has to be the https origin — and it is also where loreserver itself
 * asks whether a caller may touch a repository. Measured against loreserver
 * 0.8.6 on Windows, with the endpoint on https and nothing else done:
 *
 *   - loreserver does connect, and does start a TLS handshake.
 *   - It refuses the certificate with `tlsv1 alert unknown ca` (alert 48), and
 *     the call fails with "Failed to connect to rebac service". A repository
 *     cannot be created, and no repository can be opened.
 *   - Its TLS client is rustls with `rustls-native-certs`, which reads
 *     `SSL_CERT_FILE` before it reads the platform's own store.
 *   - With `SSL_CERT_FILE` naming Team's authority, the handshake completes and
 *     the whole flow works: `nlteam project create` succeeds and Team logs the
 *     `CreateResource` call arriving on the TLS listener.
 *
 * So the authority is handed to loreserver directly rather than by asking an
 * operator to install it on the server machine as well. It is narrower than a
 * trust store change in both directions: only this process is affected, and
 * only for as long as Team is running it.
 *
 * The one thing it costs is that loreserver, while Team supervises it, trusts
 * Team's authority and no other. Everything a Team server-configured loreserver reaches
 * is on this machine — the JWKS over the loopback in plain HTTP, and this
 * endpoint — so there is nothing else for it to verify. A configuration that
 * gave it a remote store or a telemetry endpoint over https would need the
 * public roots back, and this is the line that would have to change.
 */
function loreserverTrustAnchor(authority: TeamAuthority): Record<string, string> {
  return { SSL_CERT_FILE: authority.layout.caCertPath };
}

/** What loreserver has to be told when identity is switched on. */
function loreserverAuth(config: IdentityConfig): LoreserverAuth {
  return {
    issuer: config.issuer,
    // One entry: this is the audience loreserver requires, not the whole of
    // what a token carries. A token is accepted when its `aud` array holds it.
    audience: [config.audience],
    jwksUrl: jwksUrl(config.teamPort),
    // The https origin, because `auth_url` is what a client is told to sign in
    // at as well as where loreserver asks about a token. src/loreserver/layout.ts
    // records what that means for loreserver's own calls.
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
  let authorization: GrpcServer | undefined;
  let authorizationTls: GrpcServer | undefined;
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
      port: config.teamPort,
      // The keys directory is read again on every request, so that a
      // `nlteam key rotate` in another terminal is published without this
      // process being restarted. It is a handful of small files, and the
      // document is fetched rarely.
      jwks: async () => {
        await keys.reload();
        return keys.jwks();
      },
      version: VERSION,
    });
    stdout(`identity endpoint on ${endpoint.url}, signing with ${keys.signingKey.kid}\n`);

    // Both authorization listeners come up whether or not loreserver is told to
    // use them, so that their ports are proved free at the same moment the
    // others are, rather than on the first repository access somebody attempts.
    const service = {
      database,
      keys,
      config,
      // Only what --token-lifetime named on this command line. Everything else
      // about the two lifetimes is read from the database as each token is
      // minted, so changing a stored one reaches this process without a
      // restart.
      namedLifetimes: namedTokenLifetimes(options.overrides ?? {}),
      log: (line: string) => stdout(`${line}\n`),
      onError: (error: Error) => stderr(`nlteam: authorization service: ${error.message}\n`),
    };
    authorization = await startAuthorizationService({ ...service, port: config.authPort });
    stdout(`authorization service on ${authorization.url}\n`);

    // The certificates are generated before the listener that needs them, and
    // on every start rather than only the first: the endpoint's own certificate
    // is reissued as it approaches its expiry or when a host name is added, and
    // neither of those should wait for somebody to notice.
    const certificates = await ensureCertificates(options.root, {
      hostnames: config.hostnames,
    });
    if (certificates.generatedAuthority) {
      stdout(`generated a certificate authority in ${certificates.authority.layout.tlsDir}\n`);
    }
    if (certificates.issuedLeafBecause !== undefined) {
      stdout(
        `issued a certificate for the auth endpoint: ${certificates.issuedLeafBecause}\n`,
      );
    }

    authorizationTls = await startAuthorizationService({
      ...service,
      port: config.authTlsPort,
      // Every interface, not the loopback: this is the listener a Studio
      // installation on somebody else's machine reaches, and one bound to
      // 127.0.0.1 would be reachable by nobody but this machine — which is what
      // the plaintext listener is already for.
      anyInterface: true,
      portOption: "--auth-tls-port",
      tls: { cert: certificates.leafCertPem, key: certificates.leafKeyPem },
      // The one address an author is given resolves here. It answers before they have
      // an account, which is the point: a server that cannot say where to sign in is a
      // server somebody has to be told about in a chat message.
      http1: (request, response) =>
        serveDiscovery(
          {
            protocol: 1,
            name: hostOf(config.authOrigin),
            auth: { required: options.identity === true, url: authUrl(config) },
            data: { url: dataRemoteUrl(hostOf(config.authOrigin), config.dataPort) },
            authority: { sha256: certificates.authority.fingerprint256 },
            version: VERSION,
          },
          request,
          response,
        ),
    });
    stdout(
      `auth endpoint on port ${config.authTlsPort} of every interface, over TLS, ` +
        `reached as ${authUrl(config)}\n`,
    );
    stdout(`its certificate authority is ${certificates.authority.fingerprint256}\n`);
    stdout(
      "a machine that has not trusted this server cannot connect: compare\n" +
        "that fingerprint with\n" +
        `      nlteam trust --root ${identity.root}\n` +
        `      and then run ${trustCommandFor(certificates.authority.layout.caCertPath)}\n`,
    );

    // Where the binary is decides nothing else: it is the one thing not under
    // the storage root, and src/loreserver/install.ts answers with the path
    // that was actually used rather than the one a layout would predict.
    const install = await ensureInstalled(layout, artifact, {
      onAlreadyInstalled: (path) => stdout(`already installed at ${path}\n`),
      onFetching: (url) => stdout(`fetching ${url}\n`),
      onVerifying: (bytes) =>
        stdout(`verifying ${bytes.toLocaleString("en-US")} bytes against the pinned checksum\n`),
      onExtracting: (binDir) => stdout(`extracting into ${binDir}\n`),
    });

    // The version control library arrives through npm, which does not carry
    // the two files it is redistributed under; they come from the release
    // instead. Nothing depends on this having worked — it is an obligation of
    // shipping somebody else's library, not a precondition of running — so a
    // machine that cannot reach GitHub says so once and carries on.
    const lorelib = resolveLorelibArtifact();
    if (lorelib !== undefined) {
      try {
        const notices = await ensureLorelibNotices(options.root, lorelib);
        if (!notices.alreadyPresent) {
          stdout(`kept lorelib ${LORELIB_VERSION}'s license and notices in ${notices.directory}\n`);
        }
      } catch (error) {
        stderr(`nlteam: could not fetch lorelib's license and notices: ${describeError(error)}\n`);
      }
    }

    // Both checks run on every start, including one that installed nothing:
    // the archive digest says what was downloaded, which is not the same as
    // what is on disk now.
    await verifyBinaryDigest(install.binaryPath, artifact.binarySha256);
    const reported = await verifyBinaryVersion(install.binaryPath, LORESERVER_VERSION);
    stdout(
      `verified ${install.binaryPath} is loreserver ${reported}, matching its pinned checksum\n`,
    );

    const auth = options.identity === true ? loreserverAuth(config) : undefined;
    await writeInstance(layout, ports, auth);
    stdout(`wrote ${layout.configPath}\n`);
    if (auth === undefined) {
      stdout("loreserver will accept any client: pass --identity to make it demand a token\n");
    } else {
      stdout(`loreserver will demand a token from ${auth.issuer} for ${auth.audience[0]}\n`);
      stdout(`clients are told to sign in at ${auth.authUrl}\n`);
      // The remotes a token authorises, spelled out. A client will not send its
      // token to a remote its audience does not name, so an operator whose
      // collaborators connect by a name that is missing here has a Team server that
      // works from its own machine and nowhere else.
      stdout(
        `tokens are good for ${audienceHosts(config)
          .map((host) => dataRemoteUrl(host, config.dataPort))
          .join(", ")}\n`,
      );
      stdout(
        `loreserver reaches that endpoint too, and is given ${
          certificates.authority.layout.caCertPath
        }\n      as the only authority it trusts while Team runs it\n`,
      );
    }

    // Only a failure that ends supervision should cut the health wait short; a
    // single early exit is followed by a restart and may still come good.
    let supervisionError: Error | undefined;

    supervisor = new Supervisor({
      name: "loreserver",
      command: install.binaryPath,
      args: ["--config", layout.configDir],
      logPath: layout.logPath,
      // See the note on loreserverTrustAnchor: without this, loreserver cannot
      // reach the https `auth_url` it was configured with, and every repository
      // access fails.
      ...(auth === undefined ? {} : { env: loreserverTrustAnchor(certificates.authority) }),
      onEvent: (event) => {
        switch (event.kind) {
          case "started":
            stdout(`started loreserver, pid ${event.pid}\n`);
            break;
          case "exited":
            if (!event.deliberate) {
              stderr(`nlteam: loreserver exited: ${describeExit(event.code, event.signal)}\n`);
            }
            break;
          case "restarting":
            stderr(
              `nlteam: restarting loreserver in ${(event.delayMs / 1000).toFixed(2)}s ` +
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
      stderr(`nlteam: ${failure.message}\n`);
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
    stderr(`nlteam: ${describeError(error)}\n`);
    return 1;
  } finally {
    // Both servers hold a listening socket and the database a file handle; any
    // of them would keep the process alive after the work is over.
    if (endpoint !== undefined) {
      await endpoint.close();
    }
    if (authorization !== undefined) {
      await authorization.close();
    }
    if (authorizationTls !== undefined) {
      await authorizationTls.close();
    }
    database?.close();
  }
}

/**
 * Print a code for the first account, if there is no account yet.
 *
 * A fresh code is made on every start that finds an empty Team, because Team
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
  stdout("This server has no accounts. Make the first one with this invite code:\n");
  stdout(renderInvite(code, invite.role, invite.expiresAt, root));
}
