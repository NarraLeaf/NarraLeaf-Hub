import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DigestMismatchError,
  DownloadFailedError,
  downloadVerified,
} from "../src/loreserver/download.js";

/**
 * These tests serve the bytes from a listener on the loopback address rather
 * than reaching the internet, so they exercise the real `fetch` path, the real
 * temporary file and the real rename without depending on anything outside the
 * machine. Nothing here contacts a release server.
 */
const ARTIFACT = Buffer.from("pretend this is a release archive\n".repeat(1000));
const ARTIFACT_SHA256 = createHash("sha256").update(ARTIFACT).digest("hex");
const WRONG_SHA256 = "0".repeat(64);

interface Listener {
  readonly url: string;
  close(): Promise<void>;
}

const openListeners: Server[] = [];
const temporaryDirs: string[] = [];

/** Serve one fixed response from 127.0.0.1 on a port the system picks. */
async function listen(respond: (path: string) => { status: number; body?: Buffer }): Promise<Listener> {
  const server = createServer((request, response) => {
    const { status, body } = respond(request.url ?? "/");
    response.writeHead(status, { "content-type": "application/octet-stream" });
    response.end(body);
  });
  openListeners.push(server);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the test listener did not report a port");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function temporaryDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nlteam-download-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (openListeners.length > 0) {
    const server = openListeners.pop();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => {
      server?.close(() => resolve());
    });
  }
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("downloadVerified", () => {
  it("writes the file when the bytes hash to the pinned digest", async () => {
    const listener = await listen(() => ({ status: 200, body: ARTIFACT }));
    const dir = await temporaryDir();
    const destination = join(dir, "artifact.bin");

    await downloadVerified(`${listener.url}/artifact.bin`, destination, ARTIFACT_SHA256);

    expect(await readFile(destination)).toEqual(ARTIFACT);
    // The temporary file it streamed through is not left beside the result.
    expect(await readdir(dir)).toEqual(["artifact.bin"]);
  });

  it("leaves nothing at the destination when the digest does not match", async () => {
    const listener = await listen(() => ({ status: 200, body: ARTIFACT }));
    const dir = await temporaryDir();
    const destination = join(dir, "artifact.bin");

    await expect(
      downloadVerified(`${listener.url}/artifact.bin`, destination, WRONG_SHA256),
    ).rejects.toThrow(DigestMismatchError);

    // The rule the whole module exists for: bytes that failed the check are
    // never where something later would pick them up and run them.
    expect(existsSync(destination)).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  });

  it("shows both digests, so the mismatch can be looked into", async () => {
    const listener = await listen(() => ({ status: 200, body: ARTIFACT }));
    const dir = await temporaryDir();
    const url = `${listener.url}/artifact.bin`;

    const error = await downloadVerified(url, join(dir, "artifact.bin"), WRONG_SHA256).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(DigestMismatchError);
    expect((error as DigestMismatchError).message).toContain(WRONG_SHA256);
    expect((error as DigestMismatchError).message).toContain(ARTIFACT_SHA256);
    expect((error as DigestMismatchError).message).toContain(url);
  });

  it("does not overwrite an existing verified file with unverified bytes", async () => {
    const listener = await listen(() => ({ status: 200, body: ARTIFACT }));
    const dir = await temporaryDir();
    const destination = join(dir, "artifact.bin");
    await writeFile(destination, "the file that was already there");

    await expect(
      downloadVerified(`${listener.url}/artifact.bin`, destination, WRONG_SHA256),
    ).rejects.toThrow(DigestMismatchError);

    expect(await readFile(destination, "utf8")).toBe("the file that was already there");
  });

  it("reports the status when the server does not hand over the file", async () => {
    const listener = await listen(() => ({ status: 404 }));
    const dir = await temporaryDir();
    const destination = join(dir, "artifact.bin");

    await expect(
      downloadVerified(`${listener.url}/missing.bin`, destination, ARTIFACT_SHA256),
    ).rejects.toThrow(DownloadFailedError);
    await expect(
      downloadVerified(`${listener.url}/missing.bin`, destination, ARTIFACT_SHA256),
    ).rejects.toThrow(/404/);
    expect(existsSync(destination)).toBe(false);
  });
});
