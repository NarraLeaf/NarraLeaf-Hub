import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  VersionMismatchError,
  parseVersionOutput,
  verifyBinaryVersion,
} from "../src/loreserver/identify.js";

describe("parseVersionOutput", () => {
  it("reads the version out of the line loreserver prints", () => {
    expect(parseVersionOutput("loreserver 0.8.6\n")).toBe("0.8.6");
  });

  it("copes with the spellings a version banner varies in", () => {
    expect(parseVersionOutput("loreserver 0.8.6")).toBe("0.8.6");
    expect(parseVersionOutput("loreserver v0.8.6\n")).toBe("0.8.6");
    expect(parseVersionOutput("loreserver 0.8.6\r\n")).toBe("0.8.6");
    expect(parseVersionOutput("  loreserver   0.8.6  \n")).toBe("0.8.6");
    expect(parseVersionOutput("loreserver 0.9.0-rc.1\n")).toBe("0.9.0-rc.1");
  });

  it("finds the line among others", () => {
    expect(parseVersionOutput("a warning first\nloreserver 0.8.6\n")).toBe("0.8.6");
  });

  it("answers nothing for output that is not loreserver's", () => {
    expect(parseVersionOutput("")).toBeUndefined();
    expect(parseVersionOutput("v22.11.0\n")).toBeUndefined();
    expect(parseVersionOutput("lorekeeper 0.8.6\n")).toBeUndefined();
    expect(parseVersionOutput("loreserver\n")).toBeUndefined();
    expect(parseVersionOutput("loreserver unknown\n")).toBeUndefined();
    // A line about loreserver is not the same as loreserver saying so.
    expect(parseVersionOutput("this is not loreserver 0.8.6 at all\n")).toBeUndefined();
  });
});

describe("verifyBinaryVersion", () => {
  it("says plainly when the file is not loreserver, quoting what it printed", async () => {
    // node is a real executable that answers --version with something else,
    // which is exactly the case this is guarding against.
    const error = await verifyBinaryVersion(process.execPath, "0.8.6").catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(VersionMismatchError);
    expect((error as Error).message).toContain("does not look like loreserver");
    expect((error as Error).message).toContain(process.version);
  });

  it("says plainly when the file cannot be run", async () => {
    const missing = join(tmpdir(), "nlhub-no-such-binary");

    await expect(verifyBinaryVersion(missing, "0.8.6")).rejects.toThrow(VersionMismatchError);
    await expect(verifyBinaryVersion(missing, "0.8.6")).rejects.toThrow(
      /could not run .*nlhub-no-such-binary/,
    );
  });
});
