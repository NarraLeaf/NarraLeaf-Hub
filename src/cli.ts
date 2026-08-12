import { parseArgs } from "./args.js";
import { DEFAULT_PORTS } from "./loreserver/layout.js";
import { up } from "./up.js";
import { VERSION } from "./version.js";

/**
 * Somewhere to send a chunk of already-formatted output. `process.stdout.write`
 * satisfies it; a test can pass a function that appends to an array instead,
 * which is why `run` takes its two streams as parameters rather than reaching
 * for the process globals.
 */
export type WriteText = (text: string) => void;

/** Anything a command needs that does not come from the command line. */
export interface RunOptions {
  /**
   * Aborted when the operator interrupts the program. Commands that run until
   * stopped watch it; the rest ignore it.
   */
  readonly signal?: AbortSignal;
}

/** The text `--help` prints. */
export const USAGE = `Usage: nlhub <command> [options]

NarraLeaf Hub is a self-hosted project server for teams using NarraLeaf Studio.

Commands:
  up               Install and run loreserver, then keep it running

Options for up:
      --root <path>         Directory Hub keeps binaries, configuration,
                            stores and logs in (required)
      --data-port <port>    gRPC and QUIC port (default ${DEFAULT_PORTS.dataPort})
      --health-port <port>  HTTP health check port (default ${DEFAULT_PORTS.healthPort})

Options:
  -v, --version    Print the version and exit
  -h, --help       Print this message and exit

up runs until it is interrupted, and stops loreserver on its way out.`;

/**
 * Carry out one command line and return the process exit code.
 *
 * `--version` prints the bare version and nothing else, so that a script can
 * read it without having to strip a label off the front.
 */
export async function run(
  argv: readonly string[],
  stdout: WriteText,
  stderr: WriteText,
  options: RunOptions = {},
): Promise<number> {
  const invocation = parseArgs(argv);

  switch (invocation.kind) {
    case "version":
      stdout(`${VERSION}\n`);
      return 0;
    case "help":
      stdout(`${USAGE}\n`);
      return 0;
    case "up":
      return await up(
        {
          root: invocation.root,
          dataPort: invocation.dataPort,
          healthPort: invocation.healthPort,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        stdout,
        stderr,
      );
    case "error":
      // Prefix the program name the way command line tools conventionally do,
      // so the line still identifies its source in a wall of build output.
      stderr(`nlhub: ${invocation.message}\n`);
      return 2;
  }
}
