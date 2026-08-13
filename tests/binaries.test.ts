// Where a downloaded loreserver goes, and what happens to a Team server that already
// has one under its storage root.
//
// The rule this is about is not tidiness. Every storage root used to get a copy
// of the executable, and on Windows every copy raises a firewall prompt the
// first time it binds a port and leaves behind a rule naming that path. A
// machine that has run this test suite a few times had dozens of both, for
// directories that no longer exist.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  binariesCacheDir,
  cachedInstallDir,
  CACHE_DIRECTORY_ENV,
  storedInstallDir,
} from "../src/loreserver/cache.js";
import { ensureInstalled } from "../src/loreserver/install.js";
import { instanceLayout } from "../src/loreserver/layout.js";
import { LORESERVER_VERSION, resolveArtifact } from "../src/loreserver/pin.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-binaries-");

/**
 * The variable as this process found it.
 *
 * Restored after each test: the tests below set it to reach the code that reads
 * it, and a value left behind would send a later test file's installs
 * somewhere it did not choose.
 */
const inherited = process.env[CACHE_DIRECTORY_ENV];

afterEach(() => {
  if (inherited === undefined) {
    delete process.env[CACHE_DIRECTORY_ENV];
    return;
  }
  process.env[CACHE_DIRECTORY_ENV] = inherited;
});

/** An environment with nothing in it that this could read by accident. */
const BARE: NodeJS.ProcessEnv = {};

describe("binariesCacheDir", () => {
  it("is under LOCALAPPDATA on Windows", () => {
    expect(binariesCacheDir({ LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local" }, "win32")).toBe(
      join("C:\\Users\\ada\\AppData\\Local", "nlteam", "cache"),
    );
  });

  it("works out the Windows default when the variable is not set", () => {
    // A service account can be running with an environment block that carries
    // almost nothing. The path is the same one Windows would have named.
    expect(binariesCacheDir(BARE, "win32", "C:\\Users\\ada")).toBe(
      join("C:\\Users\\ada", "AppData", "Local", "nlteam", "cache"),
    );
  });

  it("is under Library/Caches on macOS", () => {
    expect(binariesCacheDir(BARE, "darwin", "/Users/ada")).toBe(
      join("/Users/ada", "Library", "Caches", "nlteam"),
    );
  });

  it("follows XDG_CACHE_HOME on Linux, and falls back to ~/.cache", () => {
    expect(binariesCacheDir({ XDG_CACHE_HOME: "/var/cache/ada" }, "linux", "/home/ada")).toBe(
      join("/var/cache/ada", "nlteam"),
    );
    expect(binariesCacheDir(BARE, "linux", "/home/ada")).toBe(join("/home/ada", ".cache", "nlteam"));
  });

  it("ignores a relative XDG_CACHE_HOME, as the specification says to", () => {
    // Resolving one against the working directory would put the binaries
    // wherever the operator happened to be standing when they started Team.
    expect(binariesCacheDir({ XDG_CACHE_HOME: "cache" }, "linux", "/home/ada")).toBe(
      join("/home/ada", ".cache", "nlteam"),
    );
  });

  it("takes the variable over the platform's own place, on every platform", () => {
    // What a container image is built around: the binaries are baked in at a
    // path chosen when the image was built, with nothing to download and no
    // per-user directory to depend on.
    for (const platform of ["win32", "darwin", "linux"]) {
      expect(binariesCacheDir({ [CACHE_DIRECTORY_ENV]: "/opt/nlteam" }, platform)).toBe(
        resolve("/opt/nlteam"),
      );
    }
  });

  it("answers with something absolute for this machine, whatever it is", () => {
    expect(binariesCacheDir(BARE, process.platform, homedir()).length).toBeGreaterThan(
      homedir().length,
    );
  });
});

describe("cachedInstallDir", () => {
  it("keeps two versions apart, so installing one does not overwrite the other", () => {
    expect(cachedInstallDir("loreserver", "0.8.6", "/cache")).not.toBe(
      cachedInstallDir("loreserver", "0.9.0", "/cache"),
    );
  });

  it("keeps the two programs apart as well", () => {
    expect(cachedInstallDir("loreserver", "0.8.6", "/cache")).not.toBe(
      cachedInstallDir("lorelib", "0.8.6", "/cache"),
    );
  });
});

describe("the layout of a storage root", () => {
  it("puts the binary outside it, so two Team servers on one machine share one copy", async () => {
    const cache = join(await temporaryRoot(), "cache");
    process.env[CACHE_DIRECTORY_ENV] = cache;
    const first = instanceLayout(await temporaryRoot(), "loreserver");
    const second = instanceLayout(await temporaryRoot(), "loreserver");

    expect(first.root).not.toBe(second.root);
    // One executable, and therefore one firewall rule, however many storage
    // roots this machine collects.
    expect(first.binaryPath).toBe(second.binaryPath);
    expect(first.binDir).toBe(cachedInstallDir("loreserver", LORESERVER_VERSION, cache));
  });

  it("still knows where a Team server from before that put it", async () => {
    const root = await temporaryRoot();
    const layout = instanceLayout(root, "loreserver");

    expect(layout.stored.binDir).toBe(storedInstallDir(root, "loreserver", LORESERVER_VERSION));
    expect(layout.stored.binaryPath).toBe(join(layout.stored.binDir, "loreserver"));
  });
});

describe("a Team server that already has the binary under its storage root", () => {
  /** Put the three files an unpacked release leaves where the older Team had them. */
  async function unpackStored(root: string, binaryName: string): Promise<void> {
    const layout = instanceLayout(root, binaryName);
    await mkdir(layout.stored.binDir, { recursive: true });
    for (const path of [
      layout.stored.binaryPath,
      layout.stored.licensePath,
      layout.stored.noticesPath,
    ]) {
      await writeFile(path, "not really a release, but it is all three files\n");
    }
  }

  it("goes on using it where it is, and fetches nothing", async () => {
    process.env[CACHE_DIRECTORY_ENV] = join(await temporaryRoot(), "cache");
    const root = await temporaryRoot();
    const artifact = resolveArtifact();
    await unpackStored(root, artifact.binaryName);
    const layout = instanceLayout(root, artifact.binaryName);

    // Nothing here can reach the network: the cache is empty, so a run that
    // decided to install would try to download tens of megabytes and this test
    // would not pass quickly or quietly.
    const install = await ensureInstalled(layout, artifact);

    expect(install.alreadyInstalled).toBe(true);
    expect(install.binaryPath).toBe(layout.stored.binaryPath);
    expect(install.binDir).toBe(layout.stored.binDir);
  });

  it("leaves it where it is rather than moving it", async () => {
    process.env[CACHE_DIRECTORY_ENV] = join(await temporaryRoot(), "cache");
    const root = await temporaryRoot();
    const artifact = resolveArtifact();
    await unpackStored(root, artifact.binaryName);
    const layout = instanceLayout(root, artifact.binaryName);

    await ensureInstalled(layout, artifact);

    // Moving it would mean renaming a directory whose executable may be the one
    // a supervised loreserver was started from, which Windows refuses outright:
    // the upgrade would fail on exactly the Team servers that were working.
    expect(existsSync(layout.stored.binaryPath)).toBe(true);
  });

  it("prefers the copy it already has to the one in the cache", async () => {
    const cache = join(await temporaryRoot(), "cache");
    process.env[CACHE_DIRECTORY_ENV] = cache;
    const root = await temporaryRoot();
    const artifact = resolveArtifact();
    await unpackStored(root, artifact.binaryName);
    const layout = instanceLayout(root, artifact.binaryName);
    await mkdir(layout.binDir, { recursive: true });
    for (const path of [layout.binaryPath, layout.licensePath, layout.noticesPath]) {
      await writeFile(path, "the cached copy\n");
    }

    const install = await ensureInstalled(layout, artifact);

    // The one this Team server has been running is the one it goes on running. Both are
    // the same pinned build, and swapping the path under a Team server in the middle of
    // an upgrade buys nothing.
    expect(install.binaryPath).toBe(layout.stored.binaryPath);
  });
});
