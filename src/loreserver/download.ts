/**
 * Downloading a file and proving it is the expected one.
 *
 * Kept apart from the rest of the install so the rule it exists to enforce can
 * be read in one place: bytes that do not hash to the pinned digest never
 * reach the path the caller named.
 */
import { createHash, randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Raised when downloaded bytes do not hash to the digest that was pinned. */
export class DigestMismatchError extends Error {
  constructor(
    readonly url: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `${url} does not match its pinned checksum.\n` +
        `  expected sha256 ${expected}\n` +
        `  actual   sha256 ${actual}\n` +
        "The download was discarded. Either the release assets were replaced " +
        "upstream, or something on the way here altered them.",
    );
    this.name = "DigestMismatchError";
  }
}

/** Raised when the server did not answer a download with the file. */
export class DownloadFailedError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    statusText: string,
  ) {
    super(`could not download ${url}: the server answered ${status} ${statusText}`.trimEnd());
    this.name = "DownloadFailedError";
  }
}

/** Progress the caller may report; called once per stage, in this order. */
export interface DownloadReporter {
  readonly onFetching?: (url: string) => void;
  readonly onVerifying?: (bytes: number) => void;
}

/**
 * Fetch `url` into `destination`, and put it there only if its SHA-256 matches
 * `expectedSha256`.
 *
 * The bytes are streamed to a temporary file beside the destination, and
 * hashed as they are written, so that a large artifact is never held in memory
 * and a partly written one is never mistaken for a complete one. The temporary
 * file is renamed into place after the digest matches, and removed if it does
 * not; a caller that finds a file at `destination` can rely on it having
 * passed. Being beside the destination keeps the rename within one filesystem,
 * where it is atomic.
 */
export async function downloadVerified(
  url: string,
  destination: string,
  expectedSha256: string,
  reporter: DownloadReporter = {},
): Promise<void> {
  const temporary = join(dirname(destination), `.${randomUUID()}.download`);

  reporter.onFetching?.(url);
  const response = await fetch(url);
  if (!response.ok) {
    throw new DownloadFailedError(url, response.status, response.statusText);
  }
  if (response.body === null) {
    throw new DownloadFailedError(url, response.status, "no response body");
  }

  const hash = createHash("sha256");
  let bytes = 0;

  try {
    const handle = await open(temporary, "w");
    try {
      for await (const chunk of response.body) {
        hash.update(chunk);
        bytes += chunk.byteLength;
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }

    const actual = hash.digest("hex");
    reporter.onVerifying?.(bytes);
    if (actual !== expectedSha256) {
      throw new DigestMismatchError(url, expectedSha256, actual);
    }

    // rename(2) replaces an existing destination on POSIX but fails on
    // Windows, so anything already sitting there goes first. Nothing at the
    // destination is worth keeping: it is either an abandoned download or the
    // same verified bytes.
    await rm(destination, { force: true });
    await rename(temporary, destination);
  } finally {
    // Removes the temporary file on every path that did not rename it away,
    // including a failed digest and an interrupted transfer.
    await rm(temporary, { force: true });
  }
}
