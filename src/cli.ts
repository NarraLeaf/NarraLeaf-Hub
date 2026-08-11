import { parseArgs } from "./args.js";
import { VERSION } from "./version.js";

/**
 * Somewhere to send a chunk of already-formatted output. `process.stdout.write`
 * satisfies it; a test can pass a function that appends to an array instead,
 * which is why `run` takes its two streams as parameters rather than reaching
 * for the process globals.
 */
export type WriteText = (text: string) => void;

/** The text `--help` prints. */
export const USAGE = `Usage: nlhub [options]

NarraLeaf Hub is a self-hosted project server for teams using NarraLeaf Studio.

Options:
  -v, --version    Print the version and exit
  -h, --help       Print this message and exit

No commands are available yet.`;

/**
 * Carry out one command line and return the process exit code.
 *
 * `--version` prints the bare version and nothing else, so that a script can
 * read it without having to strip a label off the front.
 */
export function run(argv: readonly string[], stdout: WriteText, stderr: WriteText): number {
  const invocation = parseArgs(argv);

  switch (invocation.kind) {
    case "version":
      stdout(`${VERSION}\n`);
      return 0;
    case "help":
      stdout(`${USAGE}\n`);
      return 0;
    case "error":
      // Prefix the program name the way command line tools conventionally do,
      // so the line still identifies its source in a wall of build output.
      stderr(`nlhub: ${invocation.message}\n`);
      return 2;
  }
}
