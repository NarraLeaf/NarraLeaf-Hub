/**
 * The lorelib build Hub reads repositories with, and the terms it comes under.
 *
 * lorelib is the shared library behind loreserver, released from the same
 * repository. Hub pins the version its loreserver pin names, so that one
 * release of Hub speaks to its own server with the library that server was
 * built alongside.
 *
 * The library itself arrives through npm rather than from here: Epic publish
 * one package per platform, each declaring `os` and `cpu`, so installing Hub's
 * dependencies puts exactly one of them on disk. What is here is the part npm
 * does not deliver.
 *
 * Those packages list `*Licenses.txt` and `*.THIRD-PARTY-NOTICES.txt` among
 * their `files`, and neither is in the published package — checked against
 * 0.8.6, where the tarball holds the library, two entry points and a README.
 * So a Hub that shipped only what npm installed would be redistributing
 * somebody else's work with the notices for it missing. The same two files are
 * in the release archive, which is what this fetches: the archive is
 * downloaded, checked against a pinned digest, and the two files are kept.
 * Nothing else in it is used — the library is npm's job.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { downloadVerified, type DownloadReporter } from "../loreserver/download.js";
import { extractArchive } from "../loreserver/extract.js";
import { LICENSE_FILE_NAME, LORESERVER_VERSION, NOTICES_FILE_NAME } from "../loreserver/pin.js";

/**
 * The lorelib version Hub reads with.
 *
 * The same number as the server: they are one release, and a library that
 * disagreed with the server about a wire format would be a thing to debug
 * rather than a version to choose.
 */
export const LORELIB_VERSION = LORESERVER_VERSION;

const RELEASE_BASE_URL = `https://github.com/EpicGames/lore/releases/download/v${LORELIB_VERSION}`;

/** One platform's release archive, carried for the two files it holds. */
export interface LorelibArtifact {
  /** The `${process.platform}-${process.arch}` pair this serves. */
  readonly target: string;
  readonly asset: string;
  readonly url: string;
  /**
   * SHA-256 of the archive, as lower-case hex, checked as it is downloaded.
   *
   * Hub's own, produced by downloading the asset and hashing it, because
   * upstream publishes neither checksums nor signatures. It attests that the
   * archive is the one this release of Hub was built against; it attests
   * nothing about who built it. Re-hash from the release page before changing
   * one.
   */
  readonly sha256: string;
}

const ARTIFACTS: Readonly<Record<string, LorelibArtifact>> = {
  "linux-x64": {
    target: "linux-x64",
    asset: `liblore-v${LORELIB_VERSION}-x86_64-unknown-linux-gnu.tar.gz`,
    url: `${RELEASE_BASE_URL}/liblore-v${LORELIB_VERSION}-x86_64-unknown-linux-gnu.tar.gz`,
    sha256: "36087136120ecd50606ea879224b96434afc437cb6d9e2ce9c3bc6e5ddbf7695",
  },
  "win32-x64": {
    target: "win32-x64",
    asset: `liblore-v${LORELIB_VERSION}-x86_64-pc-windows-msvc.zip`,
    url: `${RELEASE_BASE_URL}/liblore-v${LORELIB_VERSION}-x86_64-pc-windows-msvc.zip`,
    sha256: "1f6098c6fa492df5dd3ff0387920537bf20f4c0cf41349a48ca027c85e820e34",
  },
  "darwin-arm64": {
    target: "darwin-arm64",
    asset: `liblore-v${LORELIB_VERSION}-aarch64-apple-darwin.tar.gz`,
    url: `${RELEASE_BASE_URL}/liblore-v${LORELIB_VERSION}-aarch64-apple-darwin.tar.gz`,
    sha256: "f089e9e42510ea232e111bdcab64628136e8973bd67aecfa3de6d1bda33f299c",
  },
  "linux-arm64": {
    target: "linux-arm64",
    asset: `liblore-v${LORELIB_VERSION}-aarch64-unknown-linux-gnu-neoverse-512tvb.tar.gz`,
    url: `${RELEASE_BASE_URL}/liblore-v${LORELIB_VERSION}-aarch64-unknown-linux-gnu-neoverse-512tvb.tar.gz`,
    sha256: "ed49d0f512ed3d7736ea7764e7461434be1adb505d6777960e72326ee0a9cae3",
  },
};

/** The `${platform}-${arch}` pairs a lorelib release archive exists for. */
export function lorelibTargets(): string[] {
  return Object.keys(ARTIFACTS);
}

/** The archive for one machine, or undefined where upstream publishes none. */
export function resolveLorelibArtifact(
  platform: string = process.platform,
  arch: string = process.arch,
): LorelibArtifact | undefined {
  return ARTIFACTS[`${platform}-${arch}`];
}

/**
 * Where the notices are kept: beside loreserver's, under the storage root.
 *
 * Not literally beside the library, which npm put inside `node_modules` — that
 * directory belongs to the installer and is rewritten by it. The version is in
 * the name for the same reason it is in loreserver's: a changed pin adds a
 * directory rather than overwriting what a running Hub was started with.
 */
export function lorelibNoticesDir(root: string, version: string = LORELIB_VERSION): string {
  return join(root, "bin", `lorelib-${version}`);
}

/** What {@link ensureLorelibNotices} did, and where it put it. */
export interface NoticesResult {
  readonly directory: string;
  readonly licensePath: string;
  readonly noticesPath: string;
  /** True when both files were already there and nothing was fetched. */
  readonly alreadyPresent: boolean;
}

/**
 * Make sure lorelib's licence and third-party notices are on disk.
 *
 * Nothing depends on this having run: it is an obligation of redistributing
 * somebody else's library, not a precondition of reading a repository. A
 * machine that cannot reach GitHub still reads its projects, which is why the
 * caller is expected to let a failure here pass rather than refuse to work.
 */
export async function ensureLorelibNotices(
  root: string,
  artifact: LorelibArtifact,
  reporter: DownloadReporter = {},
): Promise<NoticesResult> {
  const directory = lorelibNoticesDir(root);
  const licensePath = join(directory, LICENSE_FILE_NAME);
  const noticesPath = join(directory, NOTICES_FILE_NAME);

  if (existsSync(licensePath) && existsSync(noticesPath)) {
    return { directory, licensePath, noticesPath, alreadyPresent: true };
  }

  const parent = dirname(directory);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, ".notices-"));

  try {
    const archivePath = join(staging, artifact.asset);
    await downloadVerified(artifact.url, archivePath, artifact.sha256, reporter);

    const unpacked = join(staging, "unpacked");
    await mkdir(unpacked);
    await extractArchive(archivePath, unpacked);

    const kept = join(staging, "kept");
    await mkdir(kept);
    for (const name of [LICENSE_FILE_NAME, NOTICES_FILE_NAME]) {
      const source = join(unpacked, name);
      if (!existsSync(source)) {
        throw new Error(
          `${artifact.asset} did not contain ${name}. The release assets are not laid out the ` +
            "way this version of Hub expects.",
        );
      }
      await rename(source, join(kept, name));
    }

    // Renamed in whole at the end, so that a run interrupted partway leaves no
    // directory a later one would take for a finished install.
    await rm(directory, { recursive: true, force: true });
    await rename(kept, directory);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  return { directory, licensePath, noticesPath, alreadyPresent: false };
}
