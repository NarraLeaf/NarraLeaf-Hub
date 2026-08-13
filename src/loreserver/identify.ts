/**
 * Establishing that the file about to be run really is the pinned loreserver.
 *
 * A file at the expected path is not proof of anything: it may have been
 * replaced by hand, left behind by an older Team, restored from a backup taken
 * when a different version was pinned, or damaged since it was installed.
 *
 * Two questions are asked, in this order. What are its bytes, and what does it
 * say it is. The digest is the stronger statement and comes first — a binary
 * whose contents are unrecognised is worth reporting as that, whatever it goes
 * on to claim about its version.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Raised when the installed binary's bytes are not the pinned ones. */
export class BinaryContentsError extends Error {
  constructor(
    readonly binaryPath: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `${binaryPath} is not the loreserver build Team pins.\n` +
        `  expected sha256 ${expected}\n` +
        `  actual   sha256 ${actual}\n` +
        "Its contents have changed since it was installed, or it was never the " +
        "pinned build. Team will not run it. Remove the file and run this again " +
        "to reinstall it.",
    );
    this.name = "BinaryContentsError";
  }
}

/** The SHA-256 of a file, as a lower-case hex string. */
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  // Streamed rather than read whole: the binary is tens of megabytes, and
  // there is no reason to hold all of it at once.
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Uint8Array);
  }
  return hash.digest("hex");
}

/**
 * Check the installed binary against the digest pinned for it.
 *
 * This runs on every start, cold install and warm start alike, and is not
 * skipped on the strength of anything recorded on disk. A marker file saying
 * the check once passed could be written by whatever wrote the binary, so it
 * would prove nothing that needed proving. Hashing costs on the order of a
 * tenth of a second, which is a small part of starting a server.
 */
export async function verifyBinaryDigest(
  binaryPath: string,
  expectedSha256: string,
): Promise<void> {
  const actual = await fileSha256(binaryPath);
  if (actual !== expectedSha256) {
    throw new BinaryContentsError(binaryPath, expectedSha256, actual);
  }
}

/** Raised when the binary is not the pinned version, or would not say. */
export class VersionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VersionMismatchError";
  }
}

/**
 * Read the version out of what `loreserver --version` printed.
 *
 * The output is one line of the form `loreserver 0.8.6`. Returns `undefined`
 * when no such line is there, which is how a binary that is not loreserver at
 * all shows up.
 */
export function parseVersionOutput(output: string): string | undefined {
  const match = /^\s*loreserver\s+v?(\d+\.\d+\.\d+[^\s]*)\s*$/m.exec(output);
  return match?.[1];
}

/** A short, quotable summary of output that could not be understood. */
function firstLine(output: string): string {
  const line = output.trim().split(/\r?\n/, 1)[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/**
 * Run `binaryPath --version` and check it against the pinned version.
 *
 * Returns the version it reported. Anything unexpected is raised as a
 * sentence an operator can act on, rather than as a failed assertion: a binary
 * in the wrong place is a mistake someone made, not a broken invariant of this
 * program.
 */
export async function verifyBinaryVersion(
  binaryPath: string,
  expectedVersion: string,
): Promise<string> {
  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await execFileAsync(binaryPath, ["--version"], {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new VersionMismatchError(
      `could not run ${binaryPath} to read its version: ${detail}`,
    );
  }

  // Some builds print a version banner on stderr; both streams are searched so
  // that this does not turn into a question about which one.
  const reported = parseVersionOutput(stdout) ?? parseVersionOutput(stderr);
  if (reported === undefined) {
    throw new VersionMismatchError(
      `${binaryPath} does not look like loreserver: asked for its version it printed ` +
        `"${firstLine(stdout || stderr)}". Remove the file and run this again to reinstall it.`,
    );
  }
  if (reported !== expectedVersion) {
    throw new VersionMismatchError(
      `${binaryPath} is loreserver ${reported}, but this version of Team runs loreserver ` +
        `${expectedVersion}. Remove the file and run this again to reinstall it.`,
    );
  }
  return reported;
}
