// Reading a project out of a loreserver that is running and serving it.
//
// This is the test for the one rule the whole feature is shaped by: Hub reads
// as a client, against its own checkout, while loreserver keeps its lock on the
// store. If that rule were ever broken the failure would not look like a
// failure — the read would wait, for ever, at no CPU, with nothing logged — so
// the assertion that the server is still answering afterwards is not a
// formality. A run that hangs here is the defect.
//
// Skipped unless NLHUB_TEST_LORESERVER_ROOT names a directory it may write to,
// because it downloads tens of megabytes and listens on two ports. Nothing in
// the default test run does either.
//
//   NLHUB_TEST_LORESERVER_ROOT=/tmp/nlhub-it node node_modules/vitest/vitest.mjs run
//
// It covers more when NLHUB_TEST_LORE_CLI names Epic's `lore` executable: with
// it the test can put a project into the repository and read it back, which is
// the half of this that a repository nobody has pushed to cannot reach. Hub
// itself has no verb that writes a revision and is not going to grow one.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { dataRemoteUrl } from "../src/identity/config.js";
import { CACHE_DIRECTORY_ENV } from "../src/loreserver/cache.js";
import { checkHealth, waitForHealth } from "../src/loreserver/health.js";
import { ensureInstalled } from "../src/loreserver/install.js";
import { instanceLayout, writeInstance } from "../src/loreserver/layout.js";
import { resolveArtifact } from "../src/loreserver/pin.js";
import { Supervisor } from "../src/loreserver/supervisor.js";
import { discardCheckout, projectCheckoutPath } from "../src/projects/cache.js";
import { readProject } from "../src/projects/read.js";
import { newProjectId } from "../src/projects/registry.js";
import { loreserverUrl, repositoryCreate } from "../src/projects/repository.js";
import { storageRootOf } from "../src/view.js";
import { encodeMsgpack } from "./msgpack-fixture.js";

const execFileAsync = promisify(execFile);

const configuredRoot = process.env["NLHUB_TEST_LORESERVER_ROOT"] ?? "";
const loreCli = process.env["NLHUB_TEST_LORE_CLI"] ?? "";

// Downloads go under the directory this test was given rather than into the
// per-user cache a real Hub on this machine would be running from. Outside the
// per-run roots, so that a server started for the second test reuses the binary
// the first one fetched instead of downloading tens of megabytes again.
if (configuredRoot !== "") {
  process.env[CACHE_DIRECTORY_ENV] = join(configuredRoot, "cache");
}

/** Away from the defaults, and away from the other integration test's pair. */
const PORTS = { dataPort: 41447, healthPort: 41449 };

/** loreserver with no auth section accepts anybody; the header still has to be there. */
const UNCHECKED_TOKEN = "unchecked";

const started: Supervisor[] = [];

afterAll(async () => {
  while (started.length > 0) {
    await started.pop()?.stop();
  }
});

/** A loreserver of its own, running, with nothing in it. */
async function serving(): Promise<{ root: string; remote: string }> {
  // One at a time, because they all want the same two ports. Without this the
  // second test's server fails to bind, its calls quietly reach the first
  // test's server instead, and both look like something else entirely.
  while (started.length > 0) {
    await started.pop()?.stop();
  }

  await mkdir(configuredRoot, { recursive: true });
  const root = await mkdtemp(join(configuredRoot, "read-"));

  const artifact = resolveArtifact();
  const layout = instanceLayout(root, artifact.binaryName);
  await ensureInstalled(layout, artifact);
  await writeInstance(layout, PORTS);

  const supervisor = new Supervisor({
    name: "loreserver",
    command: layout.binaryPath,
    args: ["--config", layout.configDir],
    logPath: layout.logPath,
  });
  started.push(supervisor);
  await supervisor.start();
  await waitForHealth(PORTS.healthPort, { timeoutMs: 60_000 });

  return { root, remote: dataRemoteUrl("127.0.0.1", PORTS.dataPort) };
}

/**
 * A repository on that server, made the way `project create` makes one.
 *
 * Retried, because the health endpoint answers before the gRPC listener is
 * bound: a health check is what `up` waits for and it is not a promise that
 * every port is open. Nothing in the product races this — an operator types
 * their next command seconds later — but a test does.
 */
async function repository(name: string): Promise<string> {
  const id = newProjectId();
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await repositoryCreate({
        url: loreserverUrl(PORTS.dataPort),
        token: UNCHECKED_TOKEN,
        id,
        name,
        description: "read by the test beside this one",
      });
      return id;
    } catch (error) {
      if (Date.now() > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

describe.skipIf(configuredRoot === "")("reading a project while loreserver serves it", () => {
  it("reads a repository nobody has pushed to, and leaves the server serving", async () => {
    const { root, remote } = await serving();
    const projectName = `empty-${Date.now().toString(36)}`;
    const projectId = await repository(projectName);

    const first = await readProject({ root, projectId, projectName, remote });

    // Zero, not absent. Hub counted, and the answer is none.
    expect(first.history.revisions).toBe(0);
    expect(first.history.branch).toBe("main");
    expect(first.file.readable).toBe(false);
    expect(first.file.reason).toMatch(/nothing has been pushed/i);
    expect(first.cloned).toBe(true);

    // The assertion this whole file exists for. A Hub that had opened the
    // served store would not have got here at all, but a Hub that had taken
    // some other lock would leave the server unable to answer.
    expect(await checkHealth(PORTS.healthPort)).toBe(true);

    // And the checkout is Hub's own, nowhere near what the server holds.
    const checkout = projectCheckoutPath(root, projectId);
    expect((await stat(checkout)).isDirectory()).toBe(true);
    expect(checkout.startsWith(storageRootOf(root))).toBe(false);

    // A second read of a repository still holding nothing clones it again
    // rather than syncing. A clone of a repository with no revisions has no
    // remote written into it, so syncing that checkout fails with "No remote
    // configured" for ever, however much is pushed afterwards. Cloning again
    // costs a couple of hundred milliseconds and nothing on the wire.
    const second = await readProject({ root, projectId, projectName, remote });
    expect(second.cloned).toBe(true);
    expect(second.history.revisions).toBe(0);

    // And throwing the cache away costs the time of one more clone.
    await discardCheckout(root, projectId);
    await expect(stat(checkout)).rejects.toThrow();
    const third = await readProject({ root, projectId, projectName, remote });
    expect(third.cloned).toBe(true);
    expect(third.history.revisions).toBe(0);
  }, 600_000);

  it.skipIf(loreCli === "")(
    "reads what a project holds without checking any of it out",
    async () => {
      const { root, remote } = await serving();
      const projectName = `filled-${Date.now().toString(36)}`;
      const projectId = await repository(projectName);

      const author = join(root, "author");
      await push(author, `${remote}/${projectName}`);

      const reading = await readProject({ root, projectId, projectName, remote });

      expect(reading.history.revisions).toBe(1);
      expect(reading.history.branch).toBe("main");
      expect(reading.history.lastMessage).toBe("the first revision");
      expect(reading.history.lastAt).toBeGreaterThan(0);
      expect(reading.history.bytes).toBeGreaterThan(0);

      expect(reading.file.readable).toBe(true);
      expect(reading.file.title).toBe("A Harbour Tale");
      expect(reading.file.stageWidth).toBe(1920);
      expect(reading.file.stageHeight).toBe(1080);
      expect(reading.file.scenes).toBe(2);
      expect(reading.file.assets).toBe(1);
      expect(reading.file.assetBytes).toBe(ASSET_BYTES);
      expect(reading.file.assetsByKind).toEqual([{ kind: "image", count: 1, bytes: ASSET_BYTES }]);

      // What the checkout actually holds: none of it. Every count above came
      // from the revision tree and from blobs fetched one at a time through
      // the store, which is the whole reason reading a project costs what it
      // costs.
      const checkout = projectCheckoutPath(root, projectId);
      await expect(stat(join(checkout, "Harbour.nlproj"))).rejects.toThrow();
      await expect(stat(join(checkout, "assets"))).rejects.toThrow();
      await expect(stat(join(checkout, "editor"))).rejects.toThrow();

      // A checkout with a revision in it is brought up to date rather than
      // made again, and says the same thing either way.
      const again = await readProject({ root, projectId, projectName, remote });
      expect(again.cloned).toBe(false);
      expect(again.history.revisions).toBe(1);
      expect(again.file.title).toBe("A Harbour Tale");

      expect(await checkHealth(PORTS.healthPort)).toBe(true);
    },
    600_000,
  );
});

const ASSET_ID = "64ce569f-7104-4c57-9baf-20d14d1e0ddb";
const ASSET_BYTES = 512 * 1024;

/**
 * Put a small project into the repository at `url`.
 *
 * Epic's own client does the writing. Hub binds no verb that makes a revision,
 * and giving it one so that a test could author something would be adding a
 * capability to the product for the benefit of the test.
 */
async function push(directory: string, url: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const lore = async (...args: string[]): Promise<void> => {
    await execFileAsync(loreCli, ["--repository", directory, ...args], {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
  };

  await execFileAsync(loreCli, ["clone", url, directory], {
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });

  const write = async (relative: string, bytes: Buffer | string): Promise<void> => {
    const path = join(directory, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, bytes);
  };

  await write(
    "Harbour.nlproj",
    encodeMsgpack({
      name: "A Harbour Tale",
      identifier: "harbour",
      metadata: { resolution: { width: 1920, height: 1080 } },
    }),
  );
  await write(
    "editor/story/index.json",
    JSON.stringify({
      schemaVersion: 1,
      stories: [{ documentPath: "editor/story/stories/one/storydoc.json" }],
    }),
  );
  await write(
    "editor/story/stories/one/storydoc.json",
    JSON.stringify({ schemaVersion: 15, scenes: { first: {}, second: {} } }),
  );
  await write(
    "assets/assets.metadata.image.json",
    JSON.stringify({ [ASSET_ID]: { id: ASSET_ID, type: "image", name: "classroom" } }),
  );
  const hex = ASSET_ID.replaceAll("-", "");
  await write(
    `assets/content/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex.slice(4)}`,
    Buffer.alloc(ASSET_BYTES, 7),
  );

  // `--scan` because nothing marked these files dirty: they were written here
  // rather than through the client, and without a walk it stages nothing and
  // the commit that follows has nothing in it.
  await lore("stage", "--scan", ".");
  await lore("commit", "the first revision");
  await lore("push");
  await rm(directory, { recursive: true, force: true }).catch(() => undefined);
}
