import { createHash } from "node:crypto";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  BinaryContentsError,
  VersionMismatchError,
  fileSha256,
  parseVersionOutput,
  verifyBinaryDigest,
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

describe("verifyBinaryDigest", () => {
  const temporaryDirs: string[] = [];

  afterEach(async () => {
    while (temporaryDirs.length > 0) {
      const dir = temporaryDirs.pop();
      if (dir !== undefined) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  /** A file standing in for an installed binary, and the digest of its bytes. */
  async function installedFile(
    contents: string,
  ): Promise<{ path: string; sha256: string }> {
    const dir = await mkdtemp(join(tmpdir(), "nlteam-identify-"));
    temporaryDirs.push(dir);
    const path = join(dir, "loreserver");
    await writeFile(path, contents);
    return { path, sha256: createHash("sha256").update(contents).digest("hex") };
  }

  it("accepts a file whose bytes are the pinned ones", async () => {
    const { path, sha256 } = await installedFile("pretend this is loreserver");

    await expect(verifyBinaryDigest(path, sha256)).resolves.toBeUndefined();
    expect(await fileSha256(path)).toBe(sha256);
  });

  it("refuses a binary that was altered after it was installed", async () => {
    const { path, sha256 } = await installedFile("pretend this is loreserver");
    // Appending to an executable leaves it runnable and leaves what it prints
    // for --version unchanged, so nothing but the digest would notice.
    await appendFile(path, Buffer.alloc(8));

    await expect(verifyBinaryDigest(path, sha256)).rejects.toThrow(BinaryContentsError);
  });

  it("names the file, both digests and what to do about it", async () => {
    const { path, sha256 } = await installedFile("pretend this is loreserver");
    await appendFile(path, "tampered");
    const actual = await fileSha256(path);

    const error = await verifyBinaryDigest(path, sha256).catch((thrown: unknown) => thrown);

    expect((error as Error).message).toContain(path);
    expect((error as Error).message).toContain(sha256);
    expect((error as Error).message).toContain(actual);
    expect((error as Error).message).toContain("Remove the file and run this again");
  });

  it("refuses a file of the right length but the wrong bytes", async () => {
    // Bit rot and a half-finished copy both leave the size alone.
    const { sha256 } = await installedFile("pretend this is loreserver");
    const { path } = await installedFile("pretend this is loreserveR");

    await expect(verifyBinaryDigest(path, sha256)).rejects.toThrow(BinaryContentsError);
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
    const missing = join(tmpdir(), "nlteam-no-such-binary");

    await expect(verifyBinaryVersion(missing, "0.8.6")).rejects.toThrow(VersionMismatchError);
    await expect(verifyBinaryVersion(missing, "0.8.6")).rejects.toThrow(
      /could not run .*nlteam-no-such-binary/,
    );
  });
});
