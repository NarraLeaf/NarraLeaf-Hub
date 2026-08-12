/**
 * Asking a loreserver binary which version it is, before running it.
 *
 * A file at the expected path is not proof of anything: it may have been
 * replaced by hand, left behind by an older Hub, or restored from a backup
 * taken when a different version was pinned. Starting the wrong server would
 * be discovered later, obscurely, as a protocol or store mismatch.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
      `${binaryPath} is loreserver ${reported}, but this version of Hub runs loreserver ` +
        `${expectedVersion}. Remove the file and run this again to reinstall it.`,
    );
  }
  return reported;
}
