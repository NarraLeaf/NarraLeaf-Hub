/**
 * Getting the pinned loreserver build onto disk.
 *
 * The result of a successful install is a directory holding the executable
 * alongside the two files Epic Games ships with it. Those two are kept, not
 * discarded: Hub redistributes somebody else's binary, and `LICENSE.txt` and
 * `THIRD-PARTY-NOTICES.txt` are the terms it is redistributed under.
 */
import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { downloadVerified } from "./download.js";
import { extractArchive } from "./extract.js";
import type { InstanceLayout } from "./layout.js";
import { LICENSE_FILE_NAME, NOTICES_FILE_NAME, type LoreserverArtifact } from "./pin.js";

/** Raised when the unpacked archive did not hold what the pin describes. */
export class ArchiveContentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveContentsError";
  }
}

/** What an install did. */
export interface InstallResult {
  readonly binaryPath: string;
  /** True when the pinned build was already unpacked and nothing was fetched. */
  readonly alreadyInstalled: boolean;
}

/** Progress an install may report. */
export interface InstallReporter {
  readonly onAlreadyInstalled?: (binaryPath: string) => void;
  readonly onFetching?: (url: string) => void;
  readonly onVerifying?: (bytes: number) => void;
  readonly onExtracting?: (binDir: string) => void;
}

/**
 * True when the install directory holds every file the archive should have
 * left there.
 *
 * This is a check of the unpacking, not of the binary: whether the executable
 * is the pinned build is settled by asking it its version, which costs a
 * process start and belongs to the caller about to run it. Checking all three
 * files rather than only the executable means an install interrupted partway
 * through extraction is repeated rather than trusted.
 */
function isUnpacked(layout: InstanceLayout): boolean {
  return (
    existsSync(layout.binaryPath) &&
    existsSync(layout.licensePath) &&
    existsSync(layout.noticesPath)
  );
}

/**
 * Make sure the pinned loreserver is unpacked at `layout.binDir`, downloading
 * it if it is not.
 *
 * Everything happens in a temporary directory beside the destination and is
 * renamed into place at the end, so an interrupted install leaves no directory
 * that a later run would mistake for a finished one.
 */
export async function ensureInstalled(
  layout: InstanceLayout,
  artifact: LoreserverArtifact,
  reporter: InstallReporter = {},
): Promise<InstallResult> {
  if (isUnpacked(layout)) {
    reporter.onAlreadyInstalled?.(layout.binaryPath);
    return { binaryPath: layout.binaryPath, alreadyInstalled: true };
  }

  const parent = dirname(layout.binDir);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, ".install-"));

  try {
    const archivePath = join(staging, artifact.asset);
    await downloadVerified(artifact.url, archivePath, artifact.sha256, {
      onFetching: (url) => reporter.onFetching?.(url),
      onVerifying: (bytes) => reporter.onVerifying?.(bytes),
    });

    reporter.onExtracting?.(layout.binDir);
    const unpacked = join(staging, "unpacked");
    await mkdir(unpacked);
    await extractArchive(archivePath, unpacked);

    for (const name of [artifact.binaryName, LICENSE_FILE_NAME, NOTICES_FILE_NAME]) {
      if (!existsSync(join(unpacked, name))) {
        throw new ArchiveContentsError(
          `${artifact.asset} did not contain ${name}. The release assets are not laid out ` +
            "the way this version of Hub expects.",
        );
      }
    }

    // tar restores the recorded mode on Unix, but a `.zip` carries none and an
    // archive could have been built without the execute bit. Setting it costs
    // nothing and Windows ignores the mode.
    await chmod(join(unpacked, artifact.binaryName), 0o755);

    await rm(layout.binDir, { recursive: true, force: true });
    await rename(unpacked, layout.binDir);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  return { binaryPath: layout.binaryPath, alreadyInstalled: false };
}
