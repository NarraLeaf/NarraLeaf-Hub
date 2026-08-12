import { appendFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { checkHealth, waitForHealth } from "../src/loreserver/health.js";
import {
  BinaryContentsError,
  verifyBinaryDigest,
  verifyBinaryVersion,
} from "../src/loreserver/identify.js";
import { ensureInstalled } from "../src/loreserver/install.js";
import { instanceLayout, writeInstance } from "../src/loreserver/layout.js";
import { LORESERVER_VERSION, resolveArtifact } from "../src/loreserver/pin.js";
import { Supervisor } from "../src/loreserver/supervisor.js";

/**
 * The whole lifecycle against a real loreserver: download, checksum, unpack,
 * configure, run, poll for health, stop.
 *
 * It is skipped unless NLHUB_TEST_LORESERVER_ROOT names a directory it may
 * write to, because it downloads tens of megabytes from GitHub and listens on
 * two ports. Nothing in the default test run does either.
 *
 *   NLHUB_TEST_LORESERVER_ROOT=/tmp/nlhub-it node node_modules/vitest/vitest.mjs run
 *
 * The directory is created if it is not there, and each run works inside a
 * fresh subdirectory of it. Leaving one run's downloads in place across runs
 * is the point of naming a directory rather than using a temporary one: the
 * second run reuses the archive instead of fetching it again.
 */
const configuredRoot = process.env["NLHUB_TEST_LORESERVER_ROOT"] ?? "";

/**
 * Ports for the test instance, chosen away from the defaults so that a run
 * does not collide with a loreserver an operator is already running.
 */
const PORTS = { dataPort: 41437, healthPort: 41439 };

const started: Supervisor[] = [];

afterAll(async () => {
  while (started.length > 0) {
    await started.pop()?.stop();
  }
});

describe.skipIf(configuredRoot === "")("loreserver, end to end", () => {
  it("installs, verifies, starts, answers its health check and stops", async () => {
    await mkdir(configuredRoot, { recursive: true });
    const root = await mkdtemp(join(configuredRoot, "run-"));

    const artifact = resolveArtifact();
    const layout = instanceLayout(root, artifact.binaryName);

    const install = await ensureInstalled(layout, artifact);
    expect(install.alreadyInstalled).toBe(false);
    expect((await stat(layout.binaryPath)).isFile()).toBe(true);
    // Epic Games' terms travel with the binary Hub redistributes.
    expect((await stat(layout.licensePath)).size).toBeGreaterThan(0);
    expect((await stat(layout.noticesPath)).size).toBeGreaterThan(0);

    // A second call finds the unpacked build and fetches nothing.
    expect((await ensureInstalled(layout, artifact)).alreadyInstalled).toBe(true);

    // The binary that came out of the archive is the one the pin describes.
    await expect(
      verifyBinaryDigest(layout.binaryPath, artifact.binarySha256),
    ).resolves.toBeUndefined();
    expect(await verifyBinaryVersion(layout.binaryPath, LORESERVER_VERSION)).toBe(
      LORESERVER_VERSION,
    );

    // Appending to a real executable leaves it runnable and leaves --version
    // saying the same thing, which is why the digest is what catches it.
    await appendFile(layout.binaryPath, "        ");
    await expect(
      verifyBinaryDigest(layout.binaryPath, artifact.binarySha256),
    ).rejects.toThrow(BinaryContentsError);
    expect(await verifyBinaryVersion(layout.binaryPath, LORESERVER_VERSION)).toBe(
      LORESERVER_VERSION,
    );

    // Put it back, so the rest of the run has the build it is meant to have.
    await rm(layout.binDir, { recursive: true, force: true });
    await ensureInstalled(layout, artifact);
    await verifyBinaryDigest(layout.binaryPath, artifact.binarySha256);

    await writeInstance(layout, PORTS);
    expect(await readFile(layout.configPath, "utf8")).toContain(`port = ${PORTS.dataPort}`);

    const supervisor = new Supervisor({
      name: "loreserver",
      command: layout.binaryPath,
      args: ["--config", layout.configDir],
      logPath: layout.logPath,
    });
    started.push(supervisor);

    await supervisor.start();
    expect(supervisor.pid).toBeGreaterThan(0);

    await waitForHealth(PORTS.healthPort, { timeoutMs: 60_000 });
    expect(await checkHealth(PORTS.healthPort)).toBe(true);

    await supervisor.stop();
    expect(supervisor.running).toBe(false);
    expect(await checkHealth(PORTS.healthPort)).toBe(false);

    // The stores loreserver was pointed at are where the configuration said.
    expect((await stat(layout.immutableStoreDir)).isDirectory()).toBe(true);
    expect((await stat(layout.mutableStoreDir)).isDirectory()).toBe(true);

    await rm(root, { recursive: true, force: true });
  }, 600_000);
});
