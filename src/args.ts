/**
 * Command line parsing for the `nlhub` executable.
 *
 * Parsing is kept separate from anything that writes output or exits, so the
 * decision the arguments describe can be inspected on its own.
 */

/** What a command line asked the program to do. */
export type Invocation =
  | { readonly kind: "version" }
  | { readonly kind: "help" }
  /** The command line was not understood; `message` explains why, in one line. */
  | { readonly kind: "error"; readonly message: string };

/**
 * Interpret the arguments that follow the program name.
 *
 * Callers pass `process.argv.slice(2)` — the node executable and the script
 * path are not part of the command line as far as this function is concerned.
 *
 * An empty command line is treated as a request for help: there are no
 * subcommands yet, so there is nothing else a bare `nlhub` could mean.
 */
export function parseArgs(argv: readonly string[]): Invocation {
  const [first, ...rest] = argv;

  if (first === undefined) {
    return { kind: "help" };
  }

  let invocation: Invocation;
  switch (first) {
    case "-v":
    case "--version":
      invocation = { kind: "version" };
      break;
    case "-h":
    case "--help":
      invocation = { kind: "help" };
      break;
    default:
      return { kind: "error", message: `unknown argument: ${first}` };
  }

  // Neither option takes a value, and there are no subcommands for a trailing
  // word to belong to, so anything after the first token is a mistake worth
  // reporting rather than quietly ignoring.
  const [extra] = rest;
  if (extra !== undefined) {
    return { kind: "error", message: `unexpected argument: ${extra}` };
  }

  return invocation;
}
