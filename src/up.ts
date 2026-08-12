/**
 * The `up` command: from nothing to a running, healthy loreserver.
 *
 * Every step announces itself, because the first one can take a minute on a
 * slow connection and a silent program is indistinguishable from a stuck one.
 */
import type { WriteText } from "./cli.js";
import { waitForHealth, healthCheckUrl } from "./loreserver/health.js";
import { verifyBinaryDigest, verifyBinaryVersion } from "./loreserver/identify.js";
import { ensureInstalled } from "./loreserver/install.js";
import { instanceLayout, writeInstance, type LoreserverPorts } from "./loreserver/layout.js";
import { LORESERVER_VERSION, resolveArtifact } from "./loreserver/pin.js";
import { Supervisor, describeExit } from "./loreserver/supervisor.js";

export interface UpOptions extends LoreserverPorts {
  /** The storage root; everything Hub writes goes underneath it. */
  readonly root: string;
  /**
   * Aborted to bring the command down. Without one, `up` runs until
   * loreserver can no longer be kept alive.
   */
  readonly signal?: AbortSignal;
}

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

  let supervisor: Supervisor | undefined;
  try {
    const artifact = resolveArtifact();
    const layout = instanceLayout(options.root, artifact.binaryName);
    stdout(`loreserver ${LORESERVER_VERSION} for ${artifact.target}\n`);
    if (artifact.caveat !== undefined) {
      stdout(`note: ${artifact.caveat}\n`);
    }
    stdout(`storage root ${layout.root}\n`);

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

    await writeInstance(layout, ports);
    stdout(`wrote ${layout.configPath}\n`);

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
  }
}
