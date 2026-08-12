/**
 * Command line parsing for the `nlhub` executable.
 *
 * Parsing is kept separate from anything that writes output or exits, so the
 * decision the arguments describe can be inspected on its own.
 */
import { DEFAULT_INVITE_LIFETIME_MS, DEFAULT_ROLE } from "./identity/invites.js";
import { DEFAULT_PORTS } from "./loreserver/layout.js";

/**
 * Identity settings named on a command line. Anything absent keeps the default
 * from src/identity/config.ts.
 *
 * The same options are accepted by every command that mints a token or writes
 * loreserver's configuration, because both sides of the comparison loreserver
 * makes have to be described the same way.
 */
export interface IdentityOverrides {
  readonly issuer?: string;
  readonly audience?: string;
  readonly authOrigin?: string;
  readonly env?: string;
  readonly idp?: string;
  readonly tokenLifetimeSeconds?: number;
  readonly hubPort?: number;
}

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
      /** True when loreserver is to be told to demand a Hub token. */
      readonly identity: boolean;
      readonly overrides: IdentityOverrides;
    }
  /** Make an invitation and print its code once. */
  | {
      readonly kind: "invite-create";
      readonly root: string;
      readonly role: string;
      readonly lifetimeMs: number;
    }
  /** List the accounts. */
  | { readonly kind: "user-list"; readonly root: string }
  /** Turn an invite code into an account. */
  | {
      readonly kind: "user-create";
      readonly root: string;
      readonly username: string;
      readonly code: string;
      readonly displayName: string | undefined;
      readonly email: string | undefined;
      readonly isServiceAccount: boolean;
    }
  | { readonly kind: "user-disable"; readonly root: string; readonly username: string }
  | { readonly kind: "user-enable"; readonly root: string; readonly username: string }
  /** Sign a token for an account that has proved who it is. */
  | {
      readonly kind: "token-mint";
      readonly root: string;
      readonly username: string;
      readonly overrides: IdentityOverrides;
    }
  /** Show the signing keys. */
  | { readonly kind: "key-list"; readonly root: string }
  /** Generate a key and sign with it from now on. */
  | { readonly kind: "key-rotate"; readonly root: string }
  /** The command line was not understood; `message` explains why, in one line. */
  | { readonly kind: "error"; readonly message: string };

/** The highest port number a listener can be given. */
const MAXIMUM_PORT = 65_535;

function error(message: string): Invocation {
  return { kind: "error", message };
}

/** Every command that keeps state needs to be told which storage root. */
function missingRoot(command: string): Invocation {
  return error(`${command} needs --root <path>, the directory Hub keeps its files in`);
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

/** Milliseconds in each unit a duration may be written with. */
const DURATION_UNITS: Readonly<Record<string, number>> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/**
 * Read a duration such as `30m`, `48h` or `7d`.
 *
 * A bare number is seconds. Returns milliseconds, or a sentence saying what
 * was wrong with it.
 */
export function parseDuration(option: string, text: string): number | string {
  const match = /^(\d+)([smhd])?$/.exec(text);
  if (match?.[1] === undefined) {
    return `${option} needs a duration such as 30m, 48h or 7d, not "${text}"`;
  }
  const amount = Number(match[1]);
  if (amount < 1) {
    return `${option} must be more than zero`;
  }
  return amount * (DURATION_UNITS[match[2] ?? "s"] ?? 1000);
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

/** A command line taken apart, before any command has interpreted it. */
interface Tokens {
  /** Everything that was not an option, in the order it was written. */
  readonly positionals: readonly string[];
  /** Options that took a value, by option name including the dashes. */
  readonly values: ReadonlyMap<string, string>;
  /** Options that stand alone. */
  readonly flags: ReadonlySet<string>;
}

type TokensResult =
  | { readonly kind: "tokens"; readonly tokens: Tokens }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

/**
 * Sort one command's arguments into options, flags and the rest.
 *
 * Every command reads its arguments through here, so that `--option value`,
 * `--option=value` and `-h` behave the same everywhere, and an option a
 * command does not have is reported rather than ignored.
 */
function readTokens(
  argv: readonly string[],
  valueOptions: readonly string[],
  flagOptions: readonly string[] = [],
): TokensResult {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      break;
    }

    if (token === "-h" || token === "--help") {
      return { kind: "help" };
    }

    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }

    const { option, value: inline } = splitInlineValue(token);
    if (flagOptions.includes(option)) {
      if (inline !== undefined) {
        return { kind: "error", message: `${option} takes no value` };
      }
      flags.add(option);
      continue;
    }
    if (!valueOptions.includes(option)) {
      return { kind: "error", message: `unknown argument: ${token}` };
    }

    let value = inline;
    if (value === undefined) {
      value = argv[index + 1];
      index += 1;
    }
    if (value === undefined || value === "") {
      return { kind: "error", message: `${option} needs a value` };
    }
    values.set(option, value);
  }

  return { kind: "tokens", tokens: { positionals, values, flags } };
}

/** The identity options every command that mints or configures accepts. */
const IDENTITY_OPTIONS = [
  "--issuer",
  "--audience",
  "--auth-origin",
  "--env",
  "--idp",
  "--token-lifetime",
  "--hub-port",
] as const;

/**
 * Collect the identity options out of a parsed command line.
 *
 * Returns a sentence instead when one of them was unusable.
 */
function readIdentityOverrides(tokens: Tokens): IdentityOverrides | string {
  const overrides: {
    issuer?: string;
    audience?: string;
    authOrigin?: string;
    env?: string;
    idp?: string;
    tokenLifetimeSeconds?: number;
    hubPort?: number;
  } = {};

  const issuer = tokens.values.get("--issuer");
  if (issuer !== undefined) {
    overrides.issuer = issuer;
  }
  const audience = tokens.values.get("--audience");
  if (audience !== undefined) {
    overrides.audience = audience;
  }
  const authOrigin = tokens.values.get("--auth-origin");
  if (authOrigin !== undefined) {
    // A scheme here would end up written twice, as https://https://host.
    if (authOrigin.includes("://")) {
      return "--auth-origin is a host, without a scheme, for example hub.example.com";
    }
    overrides.authOrigin = authOrigin;
  }
  const env = tokens.values.get("--env");
  if (env !== undefined) {
    overrides.env = env;
  }
  const idp = tokens.values.get("--idp");
  if (idp !== undefined) {
    overrides.idp = idp;
  }
  const lifetime = tokens.values.get("--token-lifetime");
  if (lifetime !== undefined) {
    const milliseconds = parseDuration("--token-lifetime", lifetime);
    if (typeof milliseconds === "string") {
      return milliseconds;
    }
    overrides.tokenLifetimeSeconds = Math.floor(milliseconds / 1000);
  }
  const hubPort = tokens.values.get("--hub-port");
  if (hubPort !== undefined) {
    const port = parsePort("--hub-port", hubPort);
    if (typeof port === "string") {
      return port;
    }
    overrides.hubPort = port;
  }

  return overrides;
}

/** Parse the arguments that follow `up`. */
function parseUp(argv: readonly string[]): Invocation {
  const result = readTokens(
    argv,
    ["--root", "--data-port", "--health-port", ...IDENTITY_OPTIONS],
    ["--identity"],
  );
  if (result.kind !== "tokens") {
    return result.kind === "help" ? { kind: "help" } : error(result.message);
  }
  const { tokens } = result;

  const extra = tokens.positionals[0];
  if (extra !== undefined) {
    return error(`unexpected argument: ${extra}`);
  }

  const root = tokens.values.get("--root");
  if (root === undefined) {
    return missingRoot("up");
  }

  let dataPort = DEFAULT_PORTS.dataPort;
  const dataPortText = tokens.values.get("--data-port");
  if (dataPortText !== undefined) {
    const port = parsePort("--data-port", dataPortText);
    if (typeof port === "string") {
      return error(port);
    }
    dataPort = port;
  }

  let healthPort = DEFAULT_PORTS.healthPort;
  const healthPortText = tokens.values.get("--health-port");
  if (healthPortText !== undefined) {
    const port = parsePort("--health-port", healthPortText);
    if (typeof port === "string") {
      return error(port);
    }
    healthPort = port;
  }

  // loreserver's gRPC and QUIC listeners deliberately share one number, one on
  // TCP and one on UDP. Its HTTP listener does not: two listeners on the same
  // TCP port would leave whichever lost the race silently absent.
  if (dataPort === healthPort) {
    return error(`--data-port and --health-port cannot both be ${dataPort}`);
  }

  const overrides = readIdentityOverrides(tokens);
  if (typeof overrides === "string") {
    return error(overrides);
  }

  return {
    kind: "up",
    root,
    dataPort,
    healthPort,
    identity: tokens.flags.has("--identity"),
    overrides,
  };
}

/** Parse the arguments that follow `invite`. */
function parseInvite(argv: readonly string[]): Invocation {
  const [verb, ...rest] = argv;
  if (verb === "-h" || verb === "--help" || verb === undefined) {
    return verb === undefined ? error("invite needs a verb: create") : { kind: "help" };
  }
  if (verb !== "create") {
    return error(`unknown invite command: ${verb}`);
  }

  const result = readTokens(rest, ["--root", "--role", "--expires"]);
  if (result.kind !== "tokens") {
    return result.kind === "help" ? { kind: "help" } : error(result.message);
  }
  const { tokens } = result;

  const extra = tokens.positionals[0];
  if (extra !== undefined) {
    return error(`unexpected argument: ${extra}`);
  }

  const root = tokens.values.get("--root");
  if (root === undefined) {
    return missingRoot("invite create");
  }

  let lifetimeMs = DEFAULT_INVITE_LIFETIME_MS;
  const expires = tokens.values.get("--expires");
  if (expires !== undefined) {
    const milliseconds = parseDuration("--expires", expires);
    if (typeof milliseconds === "string") {
      return error(milliseconds);
    }
    lifetimeMs = milliseconds;
  }

  return {
    kind: "invite-create",
    root,
    role: tokens.values.get("--role") ?? DEFAULT_ROLE,
    lifetimeMs,
  };
}

/** Parse the arguments that follow `user`. */
function parseUser(argv: readonly string[]): Invocation {
  const [verb, ...rest] = argv;
  if (verb === undefined) {
    return error("user needs a verb: list, create, disable or enable");
  }
  if (verb === "-h" || verb === "--help") {
    return { kind: "help" };
  }

  if (verb === "list") {
    const result = readTokens(rest, ["--root"]);
    if (result.kind !== "tokens") {
      return result.kind === "help" ? { kind: "help" } : error(result.message);
    }
    const root = result.tokens.values.get("--root");
    return root === undefined ? missingRoot("user list") : { kind: "user-list", root };
  }

  if (verb === "create") {
    const result = readTokens(
      rest,
      ["--root", "--invite", "--display-name", "--email"],
      ["--service-account"],
    );
    if (result.kind !== "tokens") {
      return result.kind === "help" ? { kind: "help" } : error(result.message);
    }
    const { tokens } = result;

    const username = tokens.positionals[0];
    if (username === undefined) {
      return error("user create needs a username");
    }
    if (tokens.positionals[1] !== undefined) {
      return error(`unexpected argument: ${tokens.positionals[1]}`);
    }
    const root = tokens.values.get("--root");
    if (root === undefined) {
      return missingRoot("user create");
    }
    const code = tokens.values.get("--invite");
    if (code === undefined) {
      return error("user create needs --invite <code>; every account comes from an invitation");
    }

    return {
      kind: "user-create",
      root,
      username,
      code,
      displayName: tokens.values.get("--display-name"),
      email: tokens.values.get("--email"),
      isServiceAccount: tokens.flags.has("--service-account"),
    };
  }

  if (verb === "disable" || verb === "enable") {
    const result = readTokens(rest, ["--root"]);
    if (result.kind !== "tokens") {
      return result.kind === "help" ? { kind: "help" } : error(result.message);
    }
    const { tokens } = result;
    const username = tokens.positionals[0];
    if (username === undefined) {
      return error(`user ${verb} needs a username`);
    }
    if (tokens.positionals[1] !== undefined) {
      return error(`unexpected argument: ${tokens.positionals[1]}`);
    }
    const root = tokens.values.get("--root");
    if (root === undefined) {
      return missingRoot(`user ${verb}`);
    }
    return verb === "disable"
      ? { kind: "user-disable", root, username }
      : { kind: "user-enable", root, username };
  }

  return error(`unknown user command: ${verb}`);
}

/** Parse the arguments that follow `token`. */
function parseToken(argv: readonly string[]): Invocation {
  const [verb, ...rest] = argv;
  if (verb === undefined) {
    return error("token needs a verb: mint");
  }
  if (verb === "-h" || verb === "--help") {
    return { kind: "help" };
  }
  if (verb !== "mint") {
    return error(`unknown token command: ${verb}`);
  }

  const result = readTokens(rest, ["--root", ...IDENTITY_OPTIONS]);
  if (result.kind !== "tokens") {
    return result.kind === "help" ? { kind: "help" } : error(result.message);
  }
  const { tokens } = result;

  const username = tokens.positionals[0];
  if (username === undefined) {
    return error("token mint needs a username");
  }
  if (tokens.positionals[1] !== undefined) {
    return error(`unexpected argument: ${tokens.positionals[1]}`);
  }
  const root = tokens.values.get("--root");
  if (root === undefined) {
    return missingRoot("token mint");
  }
  const overrides = readIdentityOverrides(tokens);
  if (typeof overrides === "string") {
    return error(overrides);
  }

  return { kind: "token-mint", root, username, overrides };
}

/** Parse the arguments that follow `key`. */
function parseKey(argv: readonly string[]): Invocation {
  const [verb, ...rest] = argv;
  if (verb === undefined) {
    return error("key needs a verb: list or rotate");
  }
  if (verb === "-h" || verb === "--help") {
    return { kind: "help" };
  }
  if (verb !== "list" && verb !== "rotate") {
    return error(`unknown key command: ${verb}`);
  }

  const result = readTokens(rest, ["--root"]);
  if (result.kind !== "tokens") {
    return result.kind === "help" ? { kind: "help" } : error(result.message);
  }
  const extra = result.tokens.positionals[0];
  if (extra !== undefined) {
    return error(`unexpected argument: ${extra}`);
  }
  const root = result.tokens.values.get("--root");
  if (root === undefined) {
    return missingRoot(`key ${verb}`);
  }
  return verb === "list" ? { kind: "key-list", root } : { kind: "key-rotate", root };
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
    // The only token a command consumes is its own name; the rest belong to
    // it, including any it does not recognise.
    case "up":
      return parseUp(rest);
    case "invite":
      return parseInvite(rest);
    case "user":
      return parseUser(rest);
    case "token":
      return parseToken(rest);
    case "key":
      return parseKey(rest);
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
