import { describe, expect, it } from "vitest";

import {
  LORESERVER_VERSION,
  UnsupportedPlatformError,
  resolveArtifact,
  supportedTargets,
} from "../src/loreserver/pin.js";

describe("resolveArtifact", () => {
  it("maps every supported platform to an asset built for it", () => {
    expect(resolveArtifact("linux", "x64").asset).toBe(
      `loreserver-v${LORESERVER_VERSION}-x86_64-unknown-linux-gnu.tar.gz`,
    );
    expect(resolveArtifact("win32", "x64").asset).toBe(
      `loreserver-v${LORESERVER_VERSION}-x86_64-pc-windows-msvc.zip`,
    );
    expect(resolveArtifact("darwin", "arm64").asset).toBe(
      `loreserver-v${LORESERVER_VERSION}-aarch64-apple-darwin.tar.gz`,
    );
    expect(resolveArtifact("linux", "arm64").asset).toBe(
      `loreserver-v${LORESERVER_VERSION}-aarch64-unknown-linux-gnu-neoverse-512tvb.tar.gz`,
    );
  });

  it("names the executable Windows expects, and no other platform does", () => {
    expect(resolveArtifact("win32", "x64").binaryName).toBe("loreserver.exe");
    for (const [platform, arch] of [
      ["linux", "x64"],
      ["darwin", "arm64"],
      ["linux", "arm64"],
    ] as const) {
      expect(resolveArtifact(platform, arch).binaryName).toBe("loreserver");
    }
  });

  it("downloads every asset from the pinned release", () => {
    for (const target of supportedTargets()) {
      const [platform = "", arch = ""] = target.split("-");
      const artifact = resolveArtifact(platform, arch);
      expect(artifact.url).toBe(
        `https://github.com/EpicGames/lore/releases/download/v${LORESERVER_VERSION}/${artifact.asset}`,
      );
    }
  });

  it("pins a full SHA-256 for every asset and every binary, all distinct", () => {
    const digests = supportedTargets().flatMap((target) => {
      const [platform = "", arch = ""] = target.split("-");
      const artifact = resolveArtifact(platform, arch);
      // The archive digest guards the download; the binary digest guards the
      // file that is actually run, every time it is run.
      return [artifact.sha256, artifact.binarySha256];
    });

    for (const digest of digests) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(new Set(digests).size).toBe(digests.length);
  });

  it("warns that the 64-bit ARM Linux build is not for ordinary ARM hardware", () => {
    // The asset is the neoverse-512tvb build, which uses instructions other
    // ARM parts do not have. An operator who reads nothing else should still
    // see this before it dies on an illegal instruction.
    expect(resolveArtifact("linux", "arm64").caveat).toMatch(/Neoverse/);
    expect(resolveArtifact("linux", "x64").caveat).toBeUndefined();
  });

  it("refuses an unsupported platform by name rather than guessing at one", () => {
    expect(() => resolveArtifact("freebsd", "x64")).toThrow(UnsupportedPlatformError);
    expect(() => resolveArtifact("freebsd", "x64")).toThrow(/freebsd-x64/);
    // 32-bit ARM is the case most likely to be tried, and the one where
    // quietly handing back the 64-bit build would be worst.
    expect(() => resolveArtifact("linux", "arm")).toThrow(/linux-arm\b/);
    expect(() => resolveArtifact("win32", "arm64")).toThrow(/win32-arm64/);
  });

  it("lists the platforms it does support when it refuses one", () => {
    expect(() => resolveArtifact("sunos", "x64")).toThrow(/linux-x64/);
  });

  it("reads the running machine when told nothing", () => {
    // Whatever this machine is, the answer has to be the entry for it.
    const here = `${process.platform}-${process.arch}`;
    if (supportedTargets().includes(here)) {
      expect(resolveArtifact().target).toBe(here);
    } else {
      expect(() => resolveArtifact()).toThrow(UnsupportedPlatformError);
    }
  });
});
