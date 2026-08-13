/**
 * Writing ASN.1 in the Distinguished Encoding Rules, in the amount a
 * certificate needs.
 *
 * X.509 is ASN.1, and DER is the one encoding of it that is canonical: for any
 * value there is exactly one byte string, which is what lets a signature over a
 * certificate mean anything. Every rule below that looks fussy — the shortest
 * length form, the minimal integer, the absent DEFAULT — is that canonicity.
 *
 * Everything here produces a complete tag-length-value. There is no
 * intermediate "content" type: a caller holds finished encodings and nests them,
 * which is why {@link sequence} can simply concatenate what it is given.
 *
 * Only the types a certificate uses are here. A reader is not: nothing in Team
 * parses DER, because `crypto.X509Certificate` already does, and the tests use
 * it to read back what this writes.
 */

/** Universal tag numbers, as they appear in a tag byte. */
export const TAG_BOOLEAN = 0x01;
export const TAG_INTEGER = 0x02;
export const TAG_BIT_STRING = 0x03;
export const TAG_OCTET_STRING = 0x04;
export const TAG_NULL = 0x05;
export const TAG_OBJECT_IDENTIFIER = 0x06;
export const TAG_UTF8_STRING = 0x0c;
export const TAG_PRINTABLE_STRING = 0x13;
export const TAG_IA5_STRING = 0x16;
export const TAG_UTC_TIME = 0x17;
export const TAG_GENERALIZED_TIME = 0x18;
export const TAG_SEQUENCE = 0x30;
export const TAG_SET = 0x31;

/** Raised when a value cannot be written as the ASN.1 type it was meant for. */
export class UnencodableValueError extends Error {
  constructor(reason: string) {
    super(`a DER value could not be written: ${reason}`);
    this.name = "UnencodableValueError";
  }
}

/**
 * The length octets of one value.
 *
 * DER allows exactly one spelling of a length: the short form below 128, and
 * otherwise the fewest base-256 bytes that hold it, with no leading zero. The
 * indefinite form BER permits is not legal here at all, which is why a length
 * is never written as anything but this.
 */
export function encodeLength(length: number): Buffer {
  if (!Number.isInteger(length) || length < 0) {
    throw new UnencodableValueError(`${length} is not a length`);
  }
  if (length < 0x80) {
    return Buffer.from([length]);
  }
  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining = Math.floor(remaining / 256)) {
    bytes.unshift(remaining % 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** One complete tag-length-value. */
export function tlv(tag: number, content: Buffer): Buffer {
  if (!Number.isInteger(tag) || tag < 0 || tag > 0xff) {
    // Tags above 30 need the multi-byte form, which nothing in a certificate
    // uses. Refusing is better than writing a byte that means something else.
    throw new UnencodableValueError(`${tag} is not a single-byte tag`);
  }
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

/** `BOOLEAN`. DER fixes true at 0xff, where BER allows any non-zero byte. */
export function boolean(value: boolean): Buffer {
  return tlv(TAG_BOOLEAN, Buffer.from([value ? 0xff : 0x00]));
}

/**
 * `INTEGER`, from a number or a bigint.
 *
 * The value is two's complement, big-endian, in the fewest bytes that keep its
 * sign: a positive number whose top bit is set gains a leading 0x00, and a
 * negative one is written so that its top bit is set. Getting this wrong does
 * not fail — it produces a certificate with a serial number of the wrong sign,
 * which some verifiers reject and others silently accept as a different number.
 */
export function integer(value: bigint | number): Buffer {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new UnencodableValueError(`${value} is not an integer this can write exactly`);
  }
  let magnitude = BigInt(value);
  const bytes: number[] = [];

  if (magnitude === 0n) {
    bytes.push(0);
  }
  while (magnitude !== 0n && magnitude !== -1n) {
    bytes.unshift(Number(magnitude & 0xffn));
    magnitude >>= 8n;
  }
  const first = bytes[0];
  if (value < 0) {
    // -1 shifts to -1 for ever, so the loop above stops one byte short of a
    // value that needs a leading 0xff to stay negative.
    if (first === undefined || (first & 0x80) === 0) {
      bytes.unshift(0xff);
    }
  } else if (first === undefined || (first & 0x80) !== 0) {
    bytes.unshift(0x00);
  }

  return tlv(TAG_INTEGER, Buffer.from(bytes));
}

/**
 * `INTEGER` from raw bytes read as an unsigned big-endian number.
 *
 * This is how a serial number made of random bytes is written. Leading zeroes
 * are dropped because DER's integers are minimal, and one 0x00 is put back when
 * the top bit is set so the number stays positive — a certificate serial number
 * must be, and a negative one is a certificate some clients refuse.
 */
export function unsignedInteger(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0x00) {
    start += 1;
  }
  const trimmed = bytes.subarray(start);
  const first = trimmed[0];
  const content =
    first === undefined
      ? Buffer.from([0x00])
      : (first & 0x80) === 0
        ? trimmed
        : Buffer.concat([Buffer.from([0x00]), trimmed]);
  return tlv(TAG_INTEGER, content);
}

/** `NULL`, which is the algorithm parameter every RSA signature carries. */
export function nullValue(): Buffer {
  return tlv(TAG_NULL, Buffer.alloc(0));
}

/**
 * `OBJECT IDENTIFIER`, from its dotted form.
 *
 * The first two arcs share one byte as 40 * first + second, and every arc after
 * them is base-128 with the top bit set on all but the last byte. The first arc
 * is 0, 1 or 2, and only under arc 2 may the second exceed 39 — which is why
 * that limit is checked rather than assumed.
 */
export function objectIdentifier(oid: string): Buffer {
  const arcs = oid.split(".").map((arc) => {
    if (!/^\d+$/.test(arc)) {
      throw new UnencodableValueError(`"${oid}" is not an object identifier`);
    }
    return Number(arc);
  });
  const [first, second] = arcs;
  if (arcs.length < 2 || first === undefined || second === undefined) {
    throw new UnencodableValueError(`"${oid}" has fewer than two arcs`);
  }
  if (first > 2) {
    throw new UnencodableValueError(`"${oid}" starts at arc ${first}, and the top arc is 2`);
  }
  if (first < 2 && second > 39) {
    throw new UnencodableValueError(`"${oid}" has a second arc above 39 under arc ${first}`);
  }

  const bytes: number[] = [];
  const appendBase128 = (value: number): void => {
    const septets: number[] = [];
    let remaining = value;
    do {
      septets.unshift(remaining & 0x7f);
      remaining = Math.floor(remaining / 128);
    } while (remaining > 0);
    for (const [index, septet] of septets.entries()) {
      bytes.push(index === septets.length - 1 ? septet : septet | 0x80);
    }
  };

  appendBase128(first * 40 + second);
  for (const arc of arcs.slice(2)) {
    appendBase128(arc);
  }
  return tlv(TAG_OBJECT_IDENTIFIER, Buffer.from(bytes));
}

/** `OCTET STRING`. */
export function octetString(bytes: Buffer): Buffer {
  return tlv(TAG_OCTET_STRING, bytes);
}

/**
 * `BIT STRING`.
 *
 * The first content byte counts the bits of padding at the end of the last
 * byte, and is 0 for anything that is a whole number of bytes — a signature, or
 * a public key. It is not a formality: a reader takes the value's length in
 * bits from it, so a wrong count changes the value.
 */
export function bitString(bytes: Buffer, unusedBits = 0): Buffer {
  if (!Number.isInteger(unusedBits) || unusedBits < 0 || unusedBits > 7) {
    throw new UnencodableValueError(`${unusedBits} unused bits is not between 0 and 7`);
  }
  if (bytes.length === 0 && unusedBits !== 0) {
    throw new UnencodableValueError("an empty BIT STRING cannot have unused bits");
  }
  return tlv(TAG_BIT_STRING, Buffer.concat([Buffer.from([unusedBits]), bytes]));
}

/**
 * A `BIT STRING` of named bits, as `KeyUsage` is defined.
 *
 * DER writes a named-bit list with every trailing zero bit removed, so the
 * encoding of a set of flags depends only on the highest one set. `keyCertSign`
 * and `cRLSign` — bits 5 and 6 — are therefore one content byte with one unused
 * bit, not two bytes with the rest zeroed.
 */
export function namedBits(bits: readonly number[]): Buffer {
  if (bits.length === 0) {
    return bitString(Buffer.alloc(0), 0);
  }
  const highest = Math.max(...bits);
  const bytes = Buffer.alloc(Math.floor(highest / 8) + 1);
  for (const bit of bits) {
    if (!Number.isInteger(bit) || bit < 0) {
      throw new UnencodableValueError(`${bit} is not a bit position`);
    }
    // Bit 0 is the most significant bit of the first byte: ASN.1 numbers the
    // bits of a BIT STRING from the left, which is the opposite of the way an
    // integer's bits are numbered.
    const index = Math.floor(bit / 8);
    bytes[index] = (bytes[index] ?? 0) | (0x80 >> bit % 8);
  }
  return bitString(bytes, 7 - (highest % 8));
}

/** `UTF8String`, which is what every name Team writes uses. */
export function utf8String(text: string): Buffer {
  return tlv(TAG_UTF8_STRING, Buffer.from(text, "utf8"));
}

/**
 * `PrintableString`, whose alphabet is a subset of ASCII.
 *
 * Anything outside it is refused rather than substituted: a country code is the
 * only place this is used, and one that needed escaping would not be one.
 */
export function printableString(text: string): Buffer {
  if (!/^[A-Za-z0-9 '()+,\-./:=?]*$/.test(text)) {
    throw new UnencodableValueError(`"${text}" holds characters PrintableString has no room for`);
  }
  return tlv(TAG_PRINTABLE_STRING, Buffer.from(text, "ascii"));
}

/**
 * The content octets of an `IA5String`, which is ASCII.
 *
 * They are wanted on their own as well as tagged: a host name in a
 * `subjectAltName` is `[2] IMPLICIT IA5String`, and an implicit tag replaces
 * the type's own rather than wrapping it, so there is no `IA5String` tag left
 * to take apart afterwards. A non-ASCII name has to arrive already in its
 * punycode form.
 */
export function ia5Bytes(text: string): Buffer {
  // Checked by code point rather than against an alphabet: IA5 is the whole of
  // ASCII, control characters included, and a host name that needed escaping
  // here would be one no verifier could match anyway.
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) > 0x7f) {
      throw new UnencodableValueError(`"${text}" is not ASCII, and IA5String is`);
    }
  }
  return Buffer.from(text, "ascii");
}

/** `IA5String`, tag and all. */
export function ia5String(text: string): Buffer {
  return tlv(TAG_IA5_STRING, ia5Bytes(text));
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * A time, in the representation RFC 5280 requires for the year it falls in.
 *
 * Through 2049 a certificate writes `UTCTime`, whose year is two digits; from
 * 2050 it writes `GeneralizedTime`, whose year is four. The rule is the
 * standard's, not a preference, and it is a real boundary rather than a
 * theoretical one: a certificate authority valid for ten years crosses it in
 * 2040. Both forms are seconds-precision UTC with a `Z`, and both are refused
 * fractional seconds.
 */
export function time(value: Date): Buffer {
  const year = value.getUTCFullYear();
  if (!Number.isFinite(value.getTime())) {
    throw new UnencodableValueError("a date that is not a date cannot be written");
  }
  const body =
    `${twoDigits(value.getUTCMonth() + 1)}${twoDigits(value.getUTCDate())}` +
    `${twoDigits(value.getUTCHours())}${twoDigits(value.getUTCMinutes())}` +
    `${twoDigits(value.getUTCSeconds())}Z`;

  if (year >= 1950 && year <= 2049) {
    return tlv(TAG_UTC_TIME, Buffer.from(`${twoDigits(year % 100)}${body}`, "ascii"));
  }
  if (year < 0 || year > 9999) {
    throw new UnencodableValueError(`the year ${year} does not fit a certificate`);
  }
  return tlv(TAG_GENERALIZED_TIME, Buffer.from(`${String(year).padStart(4, "0")}${body}`, "ascii"));
}

/** `SEQUENCE`, from values that are already encoded. */
export function sequence(...values: readonly Buffer[]): Buffer {
  return tlv(TAG_SEQUENCE, Buffer.concat([...values]));
}

/** `SET`, whose one use here is the single-valued RDN of a distinguished name. */
export function set(...values: readonly Buffer[]): Buffer {
  return tlv(TAG_SET, Buffer.concat([...values]));
}

/**
 * A context-specific tag wrapped around a value that keeps its own tag.
 *
 * This is what `[0] EXPLICIT` means, and it is the form the version number and
 * the extensions of a certificate use. The wrapper is always constructed: it
 * holds another complete encoding.
 */
export function explicit(tagNumber: number, value: Buffer): Buffer {
  if (!Number.isInteger(tagNumber) || tagNumber < 0 || tagNumber > 30) {
    throw new UnencodableValueError(`[${tagNumber}] needs the multi-byte tag form`);
  }
  return tlv(0xa0 | tagNumber, value);
}

/**
 * A context-specific tag that replaces a value's own tag.
 *
 * `[2] IMPLICIT IA5String` — a `dNSName` in a `subjectAltName` — is content
 * with no inner tag at all, so a reader knows the type only from the position.
 * `constructed` says whether the content is itself a series of encodings, which
 * for every implicit tag a certificate uses it is not.
 */
export function implicit(tagNumber: number, content: Buffer, constructed = false): Buffer {
  if (!Number.isInteger(tagNumber) || tagNumber < 0 || tagNumber > 30) {
    throw new UnencodableValueError(`[${tagNumber}] needs the multi-byte tag form`);
  }
  return tlv(0x80 | (constructed ? 0x20 : 0x00) | tagNumber, content);
}
