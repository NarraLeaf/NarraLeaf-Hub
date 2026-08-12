/**
 * Converting between JS values and Lore's C representations.
 *
 * The rule is that a struct field's declared type is the encoding rule: a
 * `LoreString` field takes a string, a `LoreHash` field takes 32 bytes, a
 * `LorePartition` or `LoreContext` field takes 16. There is no lookup table
 * saying which field is which, because the failure a lookup table has is
 * asymmetric and silent — a fixed-width field given something it cannot
 * measure is zero-filled by koffi and the call then succeeds against an
 * identifier of all zeroes, which is a repository that does not exist.
 *
 * {@link hashBytes} therefore checks the length and never pads.
 */
import koffi from "koffi";

/** A Lore identifier in its canonical form: lower-case hex, unprefixed. */
export type LoreHex = string;

const HEX = /^[0-9a-fA-F]*$/;

/** Lore fills an unset hash field with zeroes; that is "absent", not a value. */
const ZERO = /^0*$/;

export class LoreValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoreValueError";
  }
}

/**
 * Bytes for a fixed-width identifier field.
 *
 * The length is checked, never padded: a short value here is exactly the input
 * that produces a silently zero-filled field, so it has to be an error.
 */
export function hashBytes(hex: LoreHex, byteLength: number, field: string): { data: Buffer } {
  if (typeof hex !== "string" || !HEX.test(hex)) {
    throw new LoreValueError(`${field} must be a hex string, and this is ${JSON.stringify(hex)}`);
  }
  if (hex.length !== byteLength * 2) {
    throw new LoreValueError(
      `${field} must be ${byteLength * 2} hex characters (${byteLength} bytes), and this is ${hex.length}`,
    );
  }
  return { data: Buffer.from(hex, "hex") };
}

/** A 32-byte revision or content hash. */
export const revisionBytes = (hex: LoreHex, field = "revision"): { data: Buffer } =>
  hashBytes(hex, 32, field);

/** A 16-byte repository (partition) id. */
export const partitionBytes = (hex: LoreHex, field = "repository"): { data: Buffer } =>
  hashBytes(hex, 16, field);

/** A 16-byte branch (context) id. */
export const contextBytes = (hex: LoreHex, field = "context"): { data: Buffer } =>
  hashBytes(hex, 16, field);

export interface LoreStringValue {
  string: Buffer;
  length: number;
}

export interface LoreStringArrayValue {
  ptr: LoreStringValue[];
  count: number;
}

/**
 * A `LoreString`: a pointer plus a byte length, not a NUL-terminated string.
 *
 * koffi does not copy a Buffer argument, so the Buffer has to stay reachable
 * until the call returns or the collector can free memory a native thread is
 * still reading. That is satisfied by structure rather than by bookkeeping —
 * the args object holds this value and the caller holds the args object until
 * the call settles — which is why nothing here hands out a bare pointer. Async
 * calls make it sharper: the frame that built the arguments is long gone.
 */
export function loreString(value: string | undefined): LoreStringValue {
  const bytes = Buffer.from(value ?? "", "utf-8");
  return { string: bytes, length: bytes.byteLength };
}

/** A `LoreStringArray`: a pointer to `LoreString` plus a count. */
export function loreStringArray(values: readonly string[] | undefined): LoreStringArrayValue {
  const items = (values ?? []).map(loreString);
  return { ptr: items, count: items.length };
}

/** Lore's booleans are `uint8_t`. */
export const loreBool = (value: boolean | undefined): number => (value === true ? 1 : 0);

/**
 * A decoded koffi struct. Deliberately loose: koffi returns plain objects whose
 * field types follow the C declaration, so the readers below narrow field by
 * field rather than pretending the whole shape is known.
 */
export type DecodedStruct = Record<string, unknown> | null | undefined;

/** A struct-typed field decodes to a nested object; the cast lives here. */
export const nested = (raw: unknown, field: string): Record<string, unknown> =>
  ((raw as Record<string, unknown>)[field] ?? {}) as Record<string, unknown>;

export const decodeBool = (value: unknown): boolean => Number(value ?? 0) !== 0;

/** Lore's 64-bit counters arrive as a number or a BigInt, by magnitude. */
export const decodeCount = (value: unknown): number => Number(value ?? 0);

/** A fixed-width identifier struct (`{ data: uint8_t[N] }`) as lower-case hex. */
export function decodeHash(value: DecodedStruct): LoreHex {
  const data = value?.["data"] as ArrayLike<number> | undefined;
  if (data === undefined) {
    return "";
  }
  return Buffer.from(Uint8Array.from(Array.from(data))).toString("hex");
}

/**
 * The same, but reporting Lore's all-zero marker as absent.
 *
 * Lore fills an unset revision field with zeroes rather than omitting it, so a
 * naive read produces lookups for a revision that cannot exist.
 */
export function decodeOptionalHash(value: DecodedStruct): LoreHex | undefined {
  const hex = decodeHash(value);
  return hex.length === 0 || ZERO.test(hex) ? undefined : hex;
}

/** A `LoreString` as a JS string. Copies: the pointer only lives for the callback. */
export function decodeString(value: DecodedStruct): string {
  const pointer = value?.["string"];
  if (pointer === undefined || pointer === null) {
    return "";
  }
  const length = Number(value?.["length"] ?? 0);
  if (length === 0) {
    return "";
  }
  return toBuffer(koffi.decode(pointer, "uint8_t", length)).toString("utf-8");
}

/** A `LoreBytes` payload as a Buffer. Copies, for the same reason. */
export function decodeBytes(value: DecodedStruct): Buffer {
  const pointer = value?.["ptr"];
  const size = Number(value?.["len"] ?? 0);
  if (pointer === undefined || pointer === null || size === 0) {
    return Buffer.alloc(0);
  }
  return toBuffer(koffi.decode(pointer, "uint8_t", size));
}

/**
 * koffi hands back a Buffer, a typed array or a plain number array depending on
 * the type and the version. Normalised once here rather than at each reader.
 */
function toBuffer(decoded: unknown): Buffer {
  if (Buffer.isBuffer(decoded)) {
    return Buffer.from(decoded);
  }
  if (decoded instanceof Uint8Array) {
    return Buffer.from(decoded);
  }
  if (Array.isArray(decoded)) {
    return Buffer.from(Uint8Array.from(decoded));
  }
  throw new LoreValueError(`cannot read ${typeof decoded} as bytes`);
}
