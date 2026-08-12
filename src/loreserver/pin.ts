/**
 * The loreserver build Hub installs and runs.
 *
 * loreserver is Epic Games' content-addressed store server, released from
 * https://github.com/EpicGames/lore. Hub pins one version so that every
 * installation of one Hub release runs the same server build; nothing here
 * consults a "latest" endpoint, and no other module hard-codes a version
 * number, an asset name or a digest.
 */

/** The loreserver version this build of Hub installs. */
export const LORESERVER_VERSION = "0.8.6";

/**
 * Upstream publishes the binaries as GitHub release assets, and nothing else:
 * there is no checksum file, no signature and no package feed to verify
 * against.
 */
const RELEASE_BASE_URL = `https://github.com/EpicGames/lore/releases/download/v${LORESERVER_VERSION}`;

/** One platform's release asset, and what Hub knows about it. */
export interface LoreserverArtifact {
  /** The `${process.platform}-${process.arch}` pair this artifact serves. */
  readonly target: string;
  /** File name of the release asset. */
  readonly asset: string;
  /** Where the asset is downloaded from. */
  readonly url: string;
  /**
   * SHA-256 of the asset as a lower-case hex string.
   *
   * These digests are Hub's own: they were produced by downloading each asset
   * and hashing it, because upstream ships neither checksums nor signatures.
   * They therefore attest that an artifact is byte-for-byte the one this
   * release of Hub was tested against — they do not attest anything about who
   * built it. Re-hash the asset from the release page before changing one.
   */
  readonly sha256: string;
  /** Name of the executable inside the archive. */
  readonly binaryName: string;
  /**
   * A constraint an operator has to know about before running this build,
   * beyond the platform and architecture in the target. Absent for artifacts
   * that run on any machine of their target.
   */
  readonly caveat?: string;
}

/**
 * Every archive is flat: `LICENSE.txt`, `THIRD-PARTY-NOTICES.txt` and the
 * executable sit at its top level, with no enclosing directory.
 */
export const LICENSE_FILE_NAME = "LICENSE.txt";
export const NOTICES_FILE_NAME = "THIRD-PARTY-NOTICES.txt";

const ARTIFACTS: Readonly<Record<string, LoreserverArtifact>> = {
  "linux-x64": {
    target: "linux-x64",
    asset: `loreserver-v${LORESERVER_VERSION}-x86_64-unknown-linux-gnu.tar.gz`,
    url: `${RELEASE_BASE_URL}/loreserver-v${LORESERVER_VERSION}-x86_64-unknown-linux-gnu.tar.gz`,
    sha256: "f0de84c6175a476f157754f57316be0346105be502c93fabb65bb908eab0e1e1",
    binaryName: "loreserver",
  },
  "win32-x64": {
    target: "win32-x64",
    asset: `loreserver-v${LORESERVER_VERSION}-x86_64-pc-windows-msvc.zip`,
    url: `${RELEASE_BASE_URL}/loreserver-v${LORESERVER_VERSION}-x86_64-pc-windows-msvc.zip`,
    sha256: "4251e1419875c08485e1d316a1a0c5724e29e2c1a4d952beeb6bf3344926c75e",
    binaryName: "loreserver.exe",
  },
  "darwin-arm64": {
    target: "darwin-arm64",
    asset: `loreserver-v${LORESERVER_VERSION}-aarch64-apple-darwin.tar.gz`,
    url: `${RELEASE_BASE_URL}/loreserver-v${LORESERVER_VERSION}-aarch64-apple-darwin.tar.gz`,
    sha256: "48281fccf72ed3ba4ad3271175523595069295f4f30b936ebb15c2fa50199e4b",
    binaryName: "loreserver",
  },
  "linux-arm64": {
    // The only 64-bit ARM Linux asset upstream publishes is tuned for Neoverse
    // cores with 512-bit SVE vectors — the name says so, and the build uses
    // instructions that ordinary ARM server and desktop parts do not have. It
    // runs on the likes of AWS Graviton 3; elsewhere it is liable to die on an
    // illegal instruction rather than refuse to start.
    target: "linux-arm64",
    asset: `loreserver-v${LORESERVER_VERSION}-aarch64-unknown-linux-gnu-neoverse-512tvb.tar.gz`,
    url: `${RELEASE_BASE_URL}/loreserver-v${LORESERVER_VERSION}-aarch64-unknown-linux-gnu-neoverse-512tvb.tar.gz`,
    sha256: "01a9abf87643c46c10d9fd7d31bb3c91f371b4b66d66c39df838604ce4e9c151",
    binaryName: "loreserver",
    caveat:
      "this build targets Neoverse cores with 512-bit SVE (for example AWS Graviton 3); " +
      "it is not expected to run on other 64-bit ARM hardware",
  },
};

/** Raised when Hub has no pinned loreserver for the machine it is running on. */
export class UnsupportedPlatformError extends Error {
  constructor(readonly target: string) {
    super(
      `no loreserver ${LORESERVER_VERSION} build is available for ${target}. ` +
        `Hub can install loreserver on ${supportedTargets().join(", ")}.`,
    );
    this.name = "UnsupportedPlatformError";
  }
}

/** The `${platform}-${arch}` pairs Hub can install loreserver for. */
export function supportedTargets(): string[] {
  return Object.keys(ARTIFACTS);
}

/**
 * The artifact for one machine.
 *
 * The platform and architecture are parameters so that the mapping can be
 * examined for machines other than this one; they default to the running
 * process. A machine with no pinned build is an error rather than a fallback
 * to some other architecture's binary, which would fail later and less
 * legibly.
 */
export function resolveArtifact(
  platform: string = process.platform,
  arch: string = process.arch,
): LoreserverArtifact {
  const target = `${platform}-${arch}`;
  const artifact = ARTIFACTS[target];
  if (artifact === undefined) {
    throw new UnsupportedPlatformError(target);
  }
  return artifact;
}
