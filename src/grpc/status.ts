/**
 * gRPC's status codes, and the failure that carries one.
 *
 * A gRPC call always ends with a `grpc-status` trailer, including one that
 * succeeded, which is why nothing here is called an error code. The numbers are
 * from the protocol and are the only thing a caller sees: they travel as a
 * decimal string in a trailer, not in the response body, so a call can fail
 * after the headers said 200.
 */

/** The codes Hub sends or reads. The rest of the range is never produced here. */
export const GRPC_OK = 0;
export const GRPC_UNKNOWN = 2;
export const GRPC_INVALID_ARGUMENT = 3;
export const GRPC_DEADLINE_EXCEEDED = 4;
export const GRPC_NOT_FOUND = 5;
export const GRPC_PERMISSION_DENIED = 7;
export const GRPC_RESOURCE_EXHAUSTED = 8;
export const GRPC_UNIMPLEMENTED = 12;
export const GRPC_INTERNAL = 13;
export const GRPC_UNAVAILABLE = 14;
export const GRPC_UNAUTHENTICATED = 16;

const NAMES: Readonly<Record<number, string>> = {
  [GRPC_OK]: "OK",
  1: "CANCELLED",
  [GRPC_UNKNOWN]: "UNKNOWN",
  [GRPC_INVALID_ARGUMENT]: "INVALID_ARGUMENT",
  [GRPC_DEADLINE_EXCEEDED]: "DEADLINE_EXCEEDED",
  [GRPC_NOT_FOUND]: "NOT_FOUND",
  6: "ALREADY_EXISTS",
  [GRPC_PERMISSION_DENIED]: "PERMISSION_DENIED",
  [GRPC_RESOURCE_EXHAUSTED]: "RESOURCE_EXHAUSTED",
  9: "FAILED_PRECONDITION",
  10: "ABORTED",
  11: "OUT_OF_RANGE",
  [GRPC_UNIMPLEMENTED]: "UNIMPLEMENTED",
  [GRPC_INTERNAL]: "INTERNAL",
  [GRPC_UNAVAILABLE]: "UNAVAILABLE",
  15: "DATA_LOSS",
  [GRPC_UNAUTHENTICATED]: "UNAUTHENTICATED",
};

/** The protocol's name for a status code, for a message a person will read. */
export function statusName(status: number): string {
  return NAMES[status] ?? `status ${status}`;
}

/** A failure that is to be reported as a particular gRPC status. */
export class GrpcStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GrpcStatusError";
  }
}

/**
 * Escape a `grpc-message` trailer.
 *
 * The value is percent-encoded UTF-8: a trailer is an HTTP header, and a header
 * carrying a newline is a way to inject another header. The protocol names this
 * encoding exactly, so a receiver decodes it back into the sentence that was
 * sent.
 */
export function encodeStatusMessage(message: string): string {
  let encoded = "";
  for (const byte of Buffer.from(message, "utf8")) {
    if (byte >= 0x20 && byte <= 0x7e && byte !== 0x25) {
      encoded += String.fromCharCode(byte);
    } else {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return encoded;
}

/** Read a `grpc-message` trailer back into the sentence that was sent. */
export function decodeStatusMessage(message: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < message.length; index += 1) {
    const character = message[index] ?? "";
    const escape = character === "%" ? message.slice(index + 1, index + 3) : undefined;
    if (escape !== undefined && /^[0-9a-fA-F]{2}$/.test(escape)) {
      bytes.push(Number.parseInt(escape, 16));
      index += 2;
      continue;
    }
    bytes.push(...Buffer.from(character, "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}
