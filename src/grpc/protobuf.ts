/**
 * Reading and writing protocol buffers, in the amount Team needs.
 *
 * loreserver speaks gRPC and nothing else, in both directions: it asks Team who
 * a caller is, and Team asks it to create a repository. What that costs is this
 * file and the framing beside it, because the messages involved are a dozen
 * flat records of strings, bytes and integers. A generated stub and its runtime
 * would bring proto2, proto3, JSON mapping, reflection, descriptors and gRPC's
 * three streaming modes along to encode them.
 *
 * Only what those messages use is written here: varints, length-delimited
 * fields, and the repeated forms of both. The fixed-width wire types are
 * understood only far enough to step over one, which is deliberate — a field
 * this code has never heard of is skipped rather than refused, so a later
 * loreserver adding one does not stop Team reading the rest of the message.
 *
 * Proto3 has no way to tell a field holding its type's default from a field
 * that was never written, and nothing here pretends otherwise: an encoder omits
 * an empty string, an empty byte string and a zero, and a decoder starts from
 * those values. The one exception is an `optional` field, which proto3 does
 * distinguish, and which is decoded as `undefined` when it is absent.
 */

/** Wire types, as the low three bits of a tag spell them. */
export const WIRE_VARINT = 0;
export const WIRE_FIXED64 = 1;
export const WIRE_DELIMITED = 2;
export const WIRE_FIXED32 = 5;

/** The largest field number protobuf allows. */
const MAXIMUM_FIELD_NUMBER = 536_870_911;

/**
 * The longest a varint can be.
 *
 * Ten bytes, not nine: a negative `int32` is sign-extended to 64 bits before it
 * is written, so `-1` occupies the full ten.
 */
const MAXIMUM_VARINT_BYTES = 10;

/** Raised when bytes cannot be read as the message they claim to be. */
export class MalformedMessageError extends Error {
  constructor(reason: string) {
    super(`a protobuf message could not be read: ${reason}`);
    this.name = "MalformedMessageError";
  }
}

/** Raised when a value cannot be written as the field it is meant for. */
export class UnwritableValueError extends Error {
  constructor(reason: string) {
    super(`a protobuf message could not be written: ${reason}`);
    this.name = "UnwritableValueError";
  }
}

/**
 * One message being built.
 *
 * Fields are appended in the order they are written. Protobuf does not require
 * an order, but keeping to ascending field numbers makes two encodings of the
 * same value the same bytes, which is what lets a test compare them.
 */
export class MessageWriter {
  readonly #chunks: Buffer[] = [];

  /** Append a varint, which is how every integer and every length is written. */
  #varint(value: bigint): void {
    // Negative numbers are written as their 64-bit two's complement, which is
    // what makes an `int32` of -1 ten bytes long rather than five.
    let remaining = BigInt.asUintN(64, value);
    const bytes: number[] = [];
    do {
      const septet = Number(remaining & 0x7fn);
      remaining >>= 7n;
      bytes.push(remaining === 0n ? septet : septet | 0x80);
    } while (remaining !== 0n);
    this.#chunks.push(Buffer.from(bytes));
  }

  #tag(field: number, wireType: number): void {
    if (!Number.isInteger(field) || field < 1 || field > MAXIMUM_FIELD_NUMBER) {
      throw new UnwritableValueError(`${field} is not a field number`);
    }
    this.#varint((BigInt(field) << 3n) | BigInt(wireType));
  }

  /** Write an integer field: `int32`, `int64`, `uint64`, `bool` or an enum. */
  varint(field: number, value: number | bigint): this {
    if (typeof value === "number" && !Number.isInteger(value)) {
      throw new UnwritableValueError(`field ${field} is an integer, and ${value} is not one`);
    }
    this.#tag(field, WIRE_VARINT);
    this.#varint(BigInt(value));
    return this;
  }

  /** Write a `bytes` field. */
  bytes(field: number, value: Uint8Array): this {
    this.#tag(field, WIRE_DELIMITED);
    this.#varint(BigInt(value.byteLength));
    this.#chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    return this;
  }

  /** Write a `string` field, which is a `bytes` field holding UTF-8. */
  string(field: number, value: string): this {
    return this.bytes(field, Buffer.from(value, "utf8"));
  }

  /** Write a nested message, which is a `bytes` field holding its encoding. */
  message(field: number, value: MessageWriter): this {
    return this.bytes(field, value.finish());
  }

  /** The bytes written so far. */
  finish(): Buffer {
    return Buffer.concat(this.#chunks);
  }
}

/** A field's number and how its value is laid out, read from one tag. */
export interface FieldTag {
  readonly field: number;
  readonly wireType: number;
}

/**
 * One message being read.
 *
 * A decoder drives this in a loop: read a tag, handle the fields it knows,
 * {@link skip} the rest. Skipping the rest is not optional — a decoder that
 * stopped at an unknown field would refuse messages it could otherwise read,
 * and one that assumed the next byte was a tag would read nonsense.
 */
export class MessageReader {
  readonly #bytes: Buffer;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** True once every byte has been consumed. */
  get done(): boolean {
    return this.#offset >= this.#bytes.length;
  }

  /** Read one varint. Every integer, length and tag on the wire is one. */
  readVarint(): bigint {
    let value = 0n;
    let shift = 0n;
    for (let index = 0; index < MAXIMUM_VARINT_BYTES; index += 1) {
      const byte = this.#bytes[this.#offset];
      if (byte === undefined) {
        throw new MalformedMessageError("it ends in the middle of a number");
      }
      this.#offset += 1;
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return BigInt.asUintN(64, value);
      }
      shift += 7n;
    }
    throw new MalformedMessageError(
      `a number runs past ${MAXIMUM_VARINT_BYTES} bytes, which no 64-bit value does`,
    );
  }

  /**
   * Read one varint as a JavaScript number.
   *
   * Anything a `double` cannot hold exactly is refused rather than rounded: the
   * fields read this way are timestamps, page sizes and counters, and a value
   * outside that range means the bytes are not what they were taken for.
   */
  readNumber(): number {
    const value = this.readVarint();
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new MalformedMessageError(`${value} is too large to be read exactly`);
    }
    return Number(value);
  }

  /** Read the tag that begins every field. */
  readTag(): FieldTag {
    const tag = this.readVarint();
    const field = Number(tag >> 3n);
    if (field < 1) {
      throw new MalformedMessageError("a field is numbered 0, and field numbers start at 1");
    }
    return { field, wireType: Number(tag & 0x7n) };
  }

  /** Read a length-delimited field's bytes. */
  readDelimited(): Buffer {
    const length = this.readNumber();
    const end = this.#offset + length;
    if (end > this.#bytes.length) {
      throw new MalformedMessageError(
        `a field says it is ${length} bytes long and only ${
          this.#bytes.length - this.#offset
        } are left`,
      );
    }
    // Copied rather than referenced: a slice of a Buffer shares its memory, and
    // a decoded message outliving the frame it arrived in must not depend on
    // nobody having reused that memory.
    const bytes = Buffer.allocUnsafe(length);
    this.#bytes.copy(bytes, 0, this.#offset, end);
    this.#offset = end;
    return bytes;
  }

  /** Read a length-delimited field as UTF-8. */
  readString(): string {
    return this.readDelimited().toString("utf8");
  }

  /** Read a nested message's bytes as a reader of their own. */
  readMessage(): MessageReader {
    return new MessageReader(this.readDelimited());
  }

  /** Step over a field this decoder has no use for. */
  skip(wireType: number): void {
    switch (wireType) {
      case WIRE_VARINT:
        this.readVarint();
        return;
      case WIRE_DELIMITED:
        this.readDelimited();
        return;
      case WIRE_FIXED64:
        this.#advance(8);
        return;
      case WIRE_FIXED32:
        this.#advance(4);
        return;
      default:
        // 3 and 4 are proto2's groups, which proto3 removed; 6 and 7 have never
        // meant anything. A message carrying one is not a message this code can
        // find the end of, so it cannot be read past.
        throw new MalformedMessageError(`a field is of wire type ${wireType}, which has no length`);
    }
  }

  #advance(count: number): void {
    if (this.#offset + count > this.#bytes.length) {
      throw new MalformedMessageError("it ends in the middle of a field");
    }
    this.#offset += count;
  }
}

/**
 * Read every field of a message, handing each to `onField`.
 *
 * The handler returns true for a field it consumed; anything else is skipped
 * here, so no decoder has to remember to do it.
 */
export function readFields(
  reader: MessageReader,
  onField: (tag: FieldTag, reader: MessageReader) => boolean,
): void {
  while (!reader.done) {
    const tag = reader.readTag();
    if (!onField(tag, reader)) {
      reader.skip(tag.wireType);
    }
  }
}
