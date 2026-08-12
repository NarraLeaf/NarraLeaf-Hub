// Reading MessagePack, which is what a project file is written in.
//
// The assertion that carries the most weight is the first one: a file a real
// Studio wrote, byte for byte, read back into the settings it holds. Every
// other case here is about a file that is wrong in some way, and about the one
// thing that must never happen — a wrong file being read as a right one.
import { describe, expect, it } from "vitest";

import { decodeMsgpack, MsgpackError } from "../src/projects/msgpack.js";
import { encodeMsgpack, realProjectFile } from "./msgpack-fixture.js";

describe("a project file a real Studio wrote", () => {
  const decoded = decodeMsgpack(realProjectFile()) as Record<string, unknown>;

  it("holds the name, the identifier and the stage", () => {
    expect(decoded["name"]).toBe("Skeleton");
    expect(decoded["identifier"]).toBe("skeleton-demo");

    const metadata = decoded["metadata"] as Record<string, unknown>;
    expect(metadata["resolution"]).toEqual({ width: 1920, height: 1080 });
  });

  it("keeps text that is not ASCII", () => {
    // A length prefix counted in characters rather than bytes reads the tail
    // of one string as the head of the next, and the file still parses.
    const app = decoded["app"] as Record<string, unknown>;
    const localization = app["localization"] as Record<string, unknown>;
    const locales = localization["locales"] as Array<Record<string, unknown>>;

    expect(locales.map((locale) => locale["code"])).toEqual(["en", "zh-CN"]);
    expect(locales[1]?.["displayName"]).toBe("简体中文");
  });

  it("keeps a fraction a fraction", () => {
    // The one double in the file. Read as an integer it becomes zero, which is
    // a value the rest of the file makes look entirely reasonable.
    const metadata = decoded["metadata"] as Record<string, unknown>;
    const icons = metadata["icons"] as Record<string, unknown>;
    const specs = icons["specs"] as Record<string, Record<string, unknown>>;

    expect(specs["macos"]?.["inset"]).toBeCloseTo(0.1, 10);
    expect(specs["windows"]?.["inset"]).toBe(0);
  });
});

describe("values", () => {
  for (const value of [
    null,
    true,
    false,
    0,
    127,
    -1,
    -128,
    65535,
    1.5,
    "",
    "a name",
    "x".repeat(300),
    [],
    [1, "two", null],
    {},
    { a: 1, b: { c: [true, false] } },
  ]) {
    it(`round trips ${JSON.stringify(value)}`, () => {
      expect(decodeMsgpack(encodeMsgpack(value))).toEqual(value);
    });
  }
});

describe("a file that is not what it claims", () => {
  it("refuses an empty file", () => {
    expect(() => decodeMsgpack(Buffer.alloc(0))).toThrow(MsgpackError);
  });

  it("refuses a file that stops in the middle of a value", () => {
    const whole = encodeMsgpack({ name: "A Harbour Tale", scenes: 42 });
    for (let length = 1; length < whole.length; length += 1) {
      // Every truncation, not one: a length that happens to land on a value
      // boundary is the one a single sample would miss.
      expect(() => decodeMsgpack(whole.subarray(0, length))).toThrow(MsgpackError);
    }
  });

  it("refuses bytes after the value", () => {
    const trailing = Buffer.concat([encodeMsgpack({ a: 1 }), Buffer.from("and then some")]);
    expect(() => decodeMsgpack(trailing)).toThrow(MsgpackError);
  });

  it("refuses a type it reads nothing of, rather than skipping it", () => {
    // 0xd4 is a fixed extension type. Passing over it would hand back a value
    // with a hole in it that nothing downstream could see.
    expect(() => decodeMsgpack(Buffer.from([0xd4, 0x00, 0x00]))).toThrow(MsgpackError);
  });

  it("refuses a length that runs past the end", () => {
    // A string header claiming 200 bytes with none behind it. Left unchecked
    // this reads whatever is next in memory.
    expect(() => decodeMsgpack(Buffer.from([0xd9, 200]))).toThrow(MsgpackError);
  });

  it("refuses nesting without end", () => {
    // Ninety-nine one-entry arrays, each inside the last. Without a depth
    // limit a file like this is a stack overflow rather than a refusal.
    const nested = Buffer.alloc(99, 0x91);
    expect(() => decodeMsgpack(Buffer.concat([nested, Buffer.from([0xc0])]))).toThrow(MsgpackError);
  });
});
