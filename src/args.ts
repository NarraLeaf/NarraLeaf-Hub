/**
 * Command line parsing for the `nlhub` executable.
 *
 * Parsing is kept separate from anything that writes output or exits, so the
 * decision the arguments describe can be inspected on its own.
 */
import { DEFAULT_PORTS } from "./loreserver/layout.js";

/** What a command line asked the program to do. */
export type Invocation =
  | { readonly kind: "version" }
  | { readonly kind: "help" }
  /** Bring loreserver up under the storage root at `root`, and keep it up. */
  | {
      readonly kind: "up";
      readonly root: string;
      readonly dataPort: number;
      readonly healthPort: number;
    }
  /** The command line was not understood; `message` explains why, in one line. */
  | { readonly kind: "error"; readonly message: string };

/** The highest port number a listener can be given. */
const MAXIMUM_PORT = 65_535;

function error(message: string): Invocation {
  return { kind: "error", message };
}

/**
 * Read a port number written on the command line.
 *
 * Returns the number, or a sentence saying what was wrong with it. Anything
 * `Number` would accept but a listener would not — a fraction, a negative, a
 * number too large for a port — is rejected here rather than by the operating
 * system halfway through starting a server.
 */
function parsePort(option: string, text: string): number | string {
  if (!/^\d+$/.test(text)) {
    return `${option} needs a port number, not "${text}"`;
  }
  const port = Number(text);
  if (port < 1 || port > MAXIMUM_PORT) {
    return `${option} must be between 1 and ${MAXIMUM_PORT}, not ${port}`;
  }
  return port;
}

/**
 * Split `--option=value` into its two halves.
 *
 * Both spellings are accepted, so that neither `--root /srv/hub` nor
 * `--root=/srv/hub` is a surprise.
 */
function splitInlineValue(token: string): { option: string; value: string | undefined } {
  const separator = token.indexOf("=");
  if (!token.startsWith("--") || separator === -1) {
    return { option: token, value: undefined };
  }
  return { option: token.slice(0, separator), value: token.slice(separator + 1) };
}

/** Parse the arguments that follow `up`. */
function parseUp(argv: readonly string[]): Invocation {
  let root: string | undefined;
  let dataPort = DEFAULT_PORTS.dataPort;
  let healthPort = DEFAULT_PORTS.healthPort;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      break;
    }

    if (token === "-h" || token === "--help") {
      return { kind: "help" };
    }

    const { option, value: inline } = splitInlineValue(token);
    if (option !== "--root" && option !== "--data-port" && option !== "--health-port") {
      return error(`unknown argument: ${token}`);
    }

    let value = inline;
    if (value === undefined) {
      value = argv[index + 1];
      index += 1;
    }
    if (value === undefined || value === "") {
      return error(`${option} needs a value`);
    }

    switch (option) {
      case "--root":
        root = value;
        break;
      case "--data-port": {
        const port = parsePort(option, value);
        if (typeof port === "string") {
          return error(port);
        }
        dataPort = port;
        break;
      }
      case "--health-port": {
        const port = parsePort(option, value);
        if (typeof port === "string") {
          return error(port);
        }
        healthPort = port;
        break;
      }
    }
  }

  if (root === undefined) {
    return error("up needs --root <path>, the directory Hub keeps its files in");
  }
  // loreserver's gRPC and QUIC listeners deliberately share one number, one on
  // TCP and one on UDP. Its HTTP listener does not: two listeners on the same
  // TCP port would leave whichever lost the race silently absent.
  if (dataPort === healthPort) {
    return error(`--data-port and --health-port cannot both be ${dataPort}`);
  }

  return { kind: "up", root, dataPort, healthPort };
}

/**
 * Interpret the arguments that follow the program name.
 *
 * Callers pass `process.argv.slice(2)` — the node executable and the script
 * path are not part of the command line as far as this function is concerned.
 *
 * An empty command line is treated as a request for help: a bare `nlhub` names
 * no command, and there is nothing else it could mean.
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
    case "up":
      // The only token a command consumes is its own name; the rest belong to
      // it, including any it does not recognise.
      return parseUp(rest);
    default:
      return error(
        first.startsWith("-") ? `unknown argument: ${first}` : `unknown command: ${first}`,
      );
  }

  // Neither option takes a value, and no command follows one, so anything
  // after the first token is a mistake worth reporting rather than quietly
  // ignoring.
  const [extra] = rest;
  if (extra !== undefined) {
    return error(`unexpected argument: ${extra}`);
  }

  return invocation;
}
