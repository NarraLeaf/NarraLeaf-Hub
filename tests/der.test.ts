import { describe, expect, it } from "vitest";

import {
  bitString,
  boolean,
  encodeLength,
  explicit,
  ia5Bytes,
  ia5String,
  implicit,
  integer,
  namedBits,
  nullValue,
  objectIdentifier,
  octetString,
  printableString,
  sequence,
  set,
  time,
  tlv,
  unsignedInteger,
  UnencodableValueError,
  utf8String,
} from "../src/tls/der.js";

/** The bytes of an encoding, as a hex string, which is how they are compared here. */
function hex(value: Buffer): string {
  return value.toString("hex");
}

describe("lengths", () => {
  it("writes lengths below 128 in one byte", () => {
    expect(hex(encodeLength(0))).toBe("00");
    expect(hex(encodeLength(127))).toBe("7f");
  });

  it("writes longer lengths in the fewest bytes, with a count byte", () => {
    expect(hex(encodeLength(128))).toBe("8180");
    expect(hex(encodeLength(255))).toBe("81ff");
    expect(hex(encodeLength(256))).toBe("820100");
    expect(hex(encodeLength(65_535))).toBe("82ffff");
    expect(hex(encodeLength(65_536))).toBe("83010000");
  });

  it("refuses a length that is not one", () => {
    expect(() => encodeLength(-1)).toThrow(UnencodableValueError);
    expect(() => encodeLength(1.5)).toThrow(UnencodableValueError);
  });

  it("puts the long form on a value that needs it", () => {
    // 200 bytes of content: the header is the tag, 0x81 and the length.
    const encoded = tlv(0x04, Buffer.alloc(200));
    expect(hex(encoded.subarray(0, 3))).toBe("0481c8");
    expect(encoded.length).toBe(203);
  });
});

describe("integers", () => {
  it("writes zero as one byte", () => {
    expect(hex(integer(0))).toBe("020100");
  });

  it("keeps a positive value positive when its top bit is set", () => {
    // 128 is 0x80, whose top bit would make it -128 in two's complement.
    expect(hex(integer(128))).toBe("02020080");
    expect(hex(integer(255))).toBe("020200ff");
    expect(hex(integer(127))).toBe("02017f");
  });

  it("writes negative values in two's complement", () => {
    expect(hex(integer(-1))).toBe("0201ff");
    expect(hex(integer(-128))).toBe("020180");
    expect(hex(integer(-129))).toBe("0202ff7f");
    expect(hex(integer(-256))).toBe("0202ff00");
  });

  it("writes a bigint too large for a number", () => {
    expect(hex(integer(2n ** 64n))).toBe("0209010000000000000000");
  });

  it("refuses a number that is not an exact integer", () => {
    expect(() => integer(1.5)).toThrow(UnencodableValueError);
    expect(() => integer(2 ** 53)).toThrow(UnencodableValueError);
  });
});

describe("unsigned integers from bytes", () => {
  it("drops leading zeroes, because DER's integers are minimal", () => {
    expect(hex(unsignedInteger(Buffer.from([0x00, 0x00, 0x01, 0x02])))).toBe("02020102");
  });

  it("adds one zero when the top bit is set, so a serial stays positive", () => {
    expect(hex(unsignedInteger(Buffer.from([0xff, 0x01])))).toBe("020300ff01");
  });

  it("writes all-zero bytes as zero rather than as nothing", () => {
    expect(hex(unsignedInteger(Buffer.from([0x00, 0x00])))).toBe("020100");
  });
});

describe("object identifiers", () => {
  it("packs the first two arcs into one byte", () => {
    // 1.2.840.113549.1.1.11, sha256WithRSAEncryption.
    expect(hex(objectIdentifier("1.2.840.113549.1.1.11"))).toBe(
      "06092a864886f70d01010b",
    );
  });

  it("writes the short identifiers a certificate's names use", () => {
    expect(hex(objectIdentifier("2.5.4.3"))).toBe("0603550403");
    expect(hex(objectIdentifier("2.5.29.19"))).toBe("0603551d13");
    expect(hex(objectIdentifier("1.3.6.1.5.5.7.3.1"))).toBe("06082b06010505070301");
  });

  it("refuses arcs that cannot be written", () => {
    expect(() => objectIdentifier("3.1")).toThrow(UnencodableValueError);
    expect(() => objectIdentifier("1.40")).toThrow(UnencodableValueError);
    expect(() => objectIdentifier("2")).toThrow(UnencodableValueError);
    expect(() => objectIdentifier("1.x")).toThrow(UnencodableValueError);
  });

  it("allows a second arc above 39 only under arc 2", () => {
    expect(() => objectIdentifier("2.100.3")).not.toThrow();
  });
});

describe("bit strings", () => {
  it("writes the unused-bits byte, which is zero for whole bytes", () => {
    expect(hex(bitString(Buffer.from([0xde, 0xad])))).toBe("030300dead");
  });

  it("refuses a count of unused bits outside 0 to 7", () => {
    expect(() => bitString(Buffer.from([0x01]), 8)).toThrow(UnencodableValueError);
    expect(() => bitString(Buffer.alloc(0), 3)).toThrow(UnencodableValueError);
  });

  it("drops the trailing zero bits of a named-bit list", () => {
    // keyCertSign and cRLSign are bits 5 and 6: one content byte, one unused
    // bit. Padding it to two bytes would be a different encoding of the same
    // flags, and DER has only one.
    expect(hex(namedBits([5, 6]))).toBe("03020106");
    // digitalSignature and keyEncipherment are bits 0 and 2.
    expect(hex(namedBits([0, 2]))).toBe("030205a0");
    // decipherOnly is bit 8, which is the first bit of a second byte.
    expect(hex(namedBits([8]))).toBe("0303070080");
  });

  it("writes an empty named-bit list as an empty bit string", () => {
    expect(hex(namedBits([]))).toBe("030100");
  });
});

describe("times", () => {
  it("writes UTCTime with a two-digit year through 2049", () => {
    const encoded = time(new Date(Date.UTC(2026, 7, 11, 9, 30, 15)));
    expect(encoded[0]).toBe(0x17);
    expect(encoded.subarray(2).toString("ascii")).toBe("260811093015Z");
  });

  it("writes the last moment before the boundary as UTCTime", () => {
    const encoded = time(new Date(Date.UTC(2049, 11, 31, 23, 59, 59)));
    expect(encoded[0]).toBe(0x17);
    expect(encoded.subarray(2).toString("ascii")).toBe("491231235959Z");
  });

  it("writes GeneralizedTime with a four-digit year from 2050", () => {
    const encoded = time(new Date(Date.UTC(2050, 0, 1, 0, 0, 0)));
    expect(encoded[0]).toBe(0x18);
    expect(encoded.subarray(2).toString("ascii")).toBe("20500101000000Z");
  });

  it("writes a year before 1950 as GeneralizedTime as well", () => {
    const encoded = time(new Date(Date.UTC(1949, 0, 1, 0, 0, 0)));
    expect(encoded[0]).toBe(0x18);
    expect(encoded.subarray(2).toString("ascii")).toBe("19490101000000Z");
  });
});

describe("context-specific tags", () => {
  it("wraps a value that keeps its own tag, for an EXPLICIT tag", () => {
    // [0] EXPLICIT INTEGER 2: the version of a v3 certificate.
    expect(hex(explicit(0, integer(2)))).toBe("a003020102");
  });

  it("replaces a value's tag, for an IMPLICIT one", () => {
    // [2] IMPLICIT IA5String "localhost": a dNSName in a subjectAltName.
    expect(hex(implicit(2, ia5Bytes("localhost")))).toBe("82096c6f63616c686f7374");
  });

  it("marks a constructed implicit tag differently from a primitive one", () => {
    expect(implicit(3, Buffer.alloc(0), true)[0]).toBe(0xa3);
    expect(implicit(3, Buffer.alloc(0), false)[0]).toBe(0x83);
  });

  it("refuses a tag number that needs the multi-byte form", () => {
    expect(() => explicit(31, Buffer.alloc(0))).toThrow(UnencodableValueError);
    expect(() => implicit(31, Buffer.alloc(0))).toThrow(UnencodableValueError);
  });
});

describe("the remaining types", () => {
  it("writes booleans as DER requires, not as BER allows", () => {
    expect(hex(boolean(true))).toBe("0101ff");
    expect(hex(boolean(false))).toBe("010100");
  });

  it("writes NULL as a tag and a zero length", () => {
    expect(hex(nullValue())).toBe("0500");
  });

  it("writes strings in the type each is meant for", () => {
    expect(hex(utf8String("Ada"))).toBe("0c03416461");
    expect(hex(printableString("GB"))).toBe("13024742");
    expect(hex(ia5String("a"))).toBe("160161");
    expect(hex(octetString(Buffer.from([1, 2])))).toBe("04020102");
  });

  it("refuses characters the type has no room for", () => {
    expect(() => printableString("a@b")).toThrow(UnencodableValueError);
    expect(() => ia5String("café")).toThrow(UnencodableValueError);
  });

  it("concatenates what it is given, for a SEQUENCE and a SET", () => {
    expect(hex(sequence(integer(1), integer(2)))).toBe("3006020101020102");
    expect(hex(set(integer(1)))).toBe("3103020101");
  });
});
