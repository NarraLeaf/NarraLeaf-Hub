/**
 * Unpacking a release archive with the tar command the operating system
 * already provides.
 *
 * Team has no runtime dependencies, so it does not carry an archive library.
 * It does not need one: bsdtar has shipped in Windows since build 17063 and
 * reads both `.zip` and `.tar.gz`, and tar on Linux and macOS reads the
 * tarballs. Both spellings of the command accept the same `-xf ARCHIVE -C DIR`
 * arguments used here.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Raised when the archive could not be unpacked. */
export class ExtractionFailedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExtractionFailedError";
  }
}

/**
 * The tar to run.
 *
 * On Windows the full path to the bundled bsdtar is used in preference to
 * whatever `tar` a PATH lookup would find. Several developer toolchains — Git
 * for Windows and MSYS2 among them — put GNU tar earlier on PATH, and GNU tar
 * cannot read the `.zip` archive pinned for Windows. Elsewhere the name is
 * left to a PATH lookup, which is how tar is found on those systems.
 */
export function systemTarCommand(platform: string = process.platform): string {
  if (platform === "win32") {
    const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
    const bundled = join(systemRoot, "System32", "tar.exe");
    if (existsSync(bundled)) {
      return bundled;
    }
  }
  return "tar";
}

/** True when the failure was the command itself being absent. */
function isCommandMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * Unpack `archivePath` into `directory`, which must already exist.
 *
 * The archives are flat, so their contents land directly in `directory`.
 */
export async function extractArchive(archivePath: string, directory: string): Promise<void> {
  const command = systemTarCommand();
  try {
    await execFileAsync(command, ["-xf", archivePath, "-C", directory], {
      windowsHide: true,
      // tar says little on success and not much more on failure; the cap only
      // exists so that a pathological error cannot grow without bound.
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    if (isCommandMissing(error)) {
      throw new ExtractionFailedError(
        `cannot unpack ${archivePath}: no usable tar command was found. ` +
          "Team extracts release archives with the system tar — bsdtar on Windows 10 " +
          "build 17063 and later, tar on Linux and macOS. Install it, or put it on PATH, " +
          "and run this again.",
        { cause: error },
      );
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new ExtractionFailedError(`cannot unpack ${archivePath}: ${detail}`, { cause: error });
  }
}
