/**
 * What a session may be asked to do, as one table.
 *
 * A method is a name, a capability it belongs to, and a function of the
 * parameters and who is calling. Nothing else: no route, no status code, no
 * header. That is the point of the table, and it is why adding the sixth verb to
 * this protocol costs a file here and a caller in Studio rather than the eight
 * places the REST API needed.
 *
 * The capability a method belongs to is what the discovery document announces,
 * and it is worked out from this table rather than written beside it - see
 * {@link capabilitiesOf}. A build that cannot serve something leaves the module
 * out, and both the method and the capability disappear together. A capability
 * that is announced while its method is missing is the one failure mode a client
 * cannot recover from, because checking before asking is the whole of what a
 * capability is for.
 */
import type { UserRecord } from "../identity/users.js";
import type { StudioApiOptions } from "../web/studio.js";
import type { TeamAccount, TeamCapability, TeamErrorCode } from "./protocol.js";

/**
 * A refusal a method raises, and the one thing a handler ever throws on purpose.
 *
 * Anything else that comes out of a handler is a fault rather than an answer,
 * and is reported as `internal` with its message kept off the wire - see
 * src/team/session.ts. So the distinction here is not tidiness: it is which
 * failures a client is told the truth about.
 */
export class MethodError extends Error {
  constructor(
    readonly code: TeamErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MethodError";
  }
}

/** Everything a handler is given. */
export interface MethodContext {
  /** The service this session belongs to: the database, the keys, the reader. */
  readonly options: StudioApiOptions;
  /** Who is calling, freshly identified for this call rather than at sign-in. */
  readonly user: UserRecord;
  /** The same person, in the shape the protocol carries. */
  readonly account: TeamAccount;
  /**
   * Tell everybody listening to a topic that something happened.
   *
   * Handed to the handler rather than reached for, so that a method cannot
   * publish to a server other than its own and so that a test can watch what a
   * handler announces without a socket.
   */
  readonly publish: (topic: string, payload: unknown) => void;
}

/** One thing a session can be asked for. */
export interface TeamMethod {
  readonly name: string;
  /** Which capability this method is announced under. */
  readonly capability: TeamCapability;
  readonly handle: (params: unknown, context: MethodContext) => Promise<unknown> | unknown;
}

/**
 * The methods, by name, with a duplicate treated as a mistake rather than a
 * later definition winning.
 */
export function methodTable(methods: readonly TeamMethod[]): ReadonlyMap<string, TeamMethod> {
  const table = new Map<string, TeamMethod>();
  for (const method of methods) {
    if (table.has(method.name)) {
      throw new Error(`two methods are both called ${method.name}`);
    }
    table.set(method.name, method);
  }
  return table;
}

/**
 * What a table of methods amounts to, as capability names.
 *
 * `session` is always among them: a server answering this at all is a server
 * that has the socket, and a client with no way to say so would have to open one
 * to find out.
 */
export function capabilitiesOf(table: ReadonlyMap<string, TeamMethod>): TeamCapability[] {
  const capabilities = new Set<TeamCapability>(["session"]);
  for (const method of table.values()) {
    capabilities.add(method.capability);
  }
  return [...capabilities];
}

/* ------------------------------------------------ reading what arrived */

/**
 * The parameters as an object, refusing anything else.
 *
 * Absent parameters are an empty object rather than a refusal: a method that
 * takes nothing should be callable without a body, and every reader below
 * refuses a missing field on its own terms anyway.
 */
export function paramsObject(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) {
    return {};
  }
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new MethodError("bad-params", "the parameters are not an object");
  }
  return params as Record<string, unknown>;
}

/** A string that is there and is not blank. */
export function requiredText(
  params: Record<string, unknown>,
  name: string,
  limit: number,
): string {
  const value = params[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new MethodError("bad-params", `${name} has to be a non-empty string`);
  }
  const trimmed = value.trim();
  if (Buffer.byteLength(trimmed, "utf-8") > limit) {
    throw new MethodError("bad-params", `${name} is longer than this server stores`);
  }
  return trimmed;
}

/** A string, or nothing, refusing anything that is neither. */
export function optionalText(
  params: Record<string, unknown>,
  name: string,
  limit: number,
): string | undefined {
  const value = params[name];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new MethodError("bad-params", `${name} has to be a string`);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (Buffer.byteLength(trimmed, "utf-8") > limit) {
    throw new MethodError("bad-params", `${name} is longer than this server stores`);
  }
  return trimmed;
}

/** One of a short list of words, which is how every enumerated field arrives. */
export function oneOf<T extends string>(
  params: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
  fallback?: T,
): T {
  const value = params[name];
  if (value === undefined || value === null) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new MethodError("bad-params", `${name} has to be one of ${allowed.join(", ")}`);
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new MethodError("bad-params", `${name} has to be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

/** A whole number within bounds, with a default for the request that gave none. */
export function boundedCount(
  params: Record<string, unknown>,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const value = params[name];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new MethodError("bad-params", `${name} has to be a whole number of at least one`);
  }
  return Math.min(value, maximum);
}

/** A yes or a no, with a default. */
export function flag(params: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = params[name];
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new MethodError("bad-params", `${name} has to be true or false`);
  }
  return value;
}
