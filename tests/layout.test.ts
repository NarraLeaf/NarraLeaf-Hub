import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PORTS,
  instanceLayout,
  renderConfig,
  writeInstance,
  type InstanceLayout,
} from "../src/loreserver/layout.js";
import { LORESERVER_VERSION } from "../src/loreserver/pin.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nlhub-layout-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe("instanceLayout", () => {
  it("puts everything under the one directory it is given", async () => {
    const root = await temporaryRoot();
    const layout = instanceLayout(root, "loreserver");

    expect(layout.root).toBe(resolve(root));
    expect(layout.binDir).toBe(join(layout.root, "bin", `loreserver-${LORESERVER_VERSION}`));
    expect(layout.binaryPath).toBe(join(layout.binDir, "loreserver"));
    expect(layout.licensePath).toBe(join(layout.binDir, "LICENSE.txt"));
    expect(layout.noticesPath).toBe(join(layout.binDir, "THIRD-PARTY-NOTICES.txt"));
    expect(layout.configDir).toBe(join(layout.root, "loreserver", "config"));
    expect(layout.configPath).toBe(join(layout.configDir, "local.toml"));
    expect(layout.immutableStoreDir).toBe(
      join(layout.root, "loreserver", "store", "immutable"),
    );
    expect(layout.mutableStoreDir).toBe(join(layout.root, "loreserver", "store", "mutable"));
    expect(layout.logPath).toBe(join(layout.root, "logs", "loreserver.log"));
  });

  it("keeps the version in the directory name, so two pins can coexist", async () => {
    const root = await temporaryRoot();

    expect(instanceLayout(root, "loreserver", "0.8.6").binDir).not.toBe(
      instanceLayout(root, "loreserver", "0.9.0").binDir,
    );
  });

  it("makes a relative root absolute once, here", () => {
    // loreserver is started with a different working directory in mind than
    // the shell that typed the path; a relative path resolved twice would
    // resolve to two places.
    expect(resolve(instanceLayout("relative-root", "loreserver").root)).toBe(
      resolve("relative-root"),
    );
  });
});

describe("renderConfig", () => {
  /** A layout with fixed paths, so the rendering can be checked exactly. */
  const layout: InstanceLayout = {
    root: "C:\\srv\\hub",
    binDir: "C:\\srv\\hub\\bin\\loreserver-0.8.6",
    binaryPath: "C:\\srv\\hub\\bin\\loreserver-0.8.6\\loreserver.exe",
    licensePath: "C:\\srv\\hub\\bin\\loreserver-0.8.6\\LICENSE.txt",
    noticesPath: "C:\\srv\\hub\\bin\\loreserver-0.8.6\\THIRD-PARTY-NOTICES.txt",
    configDir: "C:\\srv\\hub\\loreserver\\config",
    configPath: "C:\\srv\\hub\\loreserver\\config\\local.toml",
    immutableStoreDir: "C:\\srv\\hub\\loreserver\\store\\immutable",
    mutableStoreDir: "C:\\srv\\hub\\loreserver\\store\\mutable",
    logDir: "C:\\srv\\hub\\logs",
    logPath: "C:\\srv\\hub\\logs\\loreserver.log",
  };

  it("writes the tables and keys loreserver reads", () => {
    expect(renderConfig(layout, { dataPort: 41337, healthPort: 41339 })).toBe(
      [
        "[immutable_store.local]",
        'path = "C:/srv/hub/loreserver/store/immutable"',
        "[mutable_store.local]",
        'path = "C:/srv/hub/loreserver/store/mutable"',
        "[server.grpc]",
        "port = 41337",
        "[server.quic]",
        "port = 41337",
        "[server.http]",
        "port = 41339",
        "",
      ].join("\n"),
    );
  });

  it("gives gRPC and QUIC the same port, and the health check a different one", () => {
    const toml = renderConfig(layout, { dataPort: 5000, healthPort: 5001 });

    // One number on TCP and UDP is deliberate; two listeners on one TCP port
    // would not be.
    expect(toml).toContain("[server.grpc]\nport = 5000");
    expect(toml).toContain("[server.quic]\nport = 5000");
    expect(toml).toContain("[server.http]\nport = 5001");
  });

  it("writes paths with forward slashes, which TOML does not treat as escapes", () => {
    const toml = renderConfig(layout, DEFAULT_PORTS);

    // A backslash inside a TOML basic string begins an escape sequence, so a
    // Windows path written verbatim would be a different path or a parse error.
    expect(toml).not.toContain("\\");
  });
});

describe("writeInstance", () => {
  it("creates the directories loreserver needs and writes its config", async () => {
    const root = await temporaryRoot();
    const layout = instanceLayout(root, "loreserver");

    await writeInstance(layout, DEFAULT_PORTS);

    for (const directory of [
      layout.configDir,
      layout.immutableStoreDir,
      layout.mutableStoreDir,
      layout.logDir,
    ]) {
      expect((await stat(directory)).isDirectory()).toBe(true);
    }
    expect(await readFile(layout.configPath, "utf8")).toBe(
      renderConfig(layout, DEFAULT_PORTS),
    );
  });

  it("replaces a config left over from a run with different ports", async () => {
    const root = await temporaryRoot();
    const layout = instanceLayout(root, "loreserver");

    await writeInstance(layout, { dataPort: 41337, healthPort: 41339 });
    await writeInstance(layout, { dataPort: 5000, healthPort: 5001 });

    const toml = await readFile(layout.configPath, "utf8");
    expect(toml).toContain("port = 5000");
    expect(toml).not.toContain("41337");
  });
});
