/**
 * Where everything belonging to one loreserver instance lives, and the
 * configuration file Hub writes for it.
 *
 * An operator supplies one path — the storage root — and every other location
 * is derived from it, so that a Hub instance can be moved, backed up or
 * deleted by acting on a single directory.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { LORESERVER_VERSION, LICENSE_FILE_NAME, NOTICES_FILE_NAME } from "./pin.js";

/** Port numbers loreserver listens on. */
export interface LoreserverPorts {
  /**
   * The gRPC and QUIC port. loreserver takes two settings, but one number
   * serves both: gRPC listens on TCP and QUIC on UDP, so they do not collide.
   */
  readonly dataPort: number;
  /** The HTTP port carrying the health check endpoint. */
  readonly healthPort: number;
}

/** The ports used when an operator names none. */
export const DEFAULT_PORTS: LoreserverPorts = {
  dataPort: 41337,
  healthPort: 41339,
};

/** Absolute paths belonging to one storage root. */
export interface InstanceLayout {
  /** The storage root itself, absolute. */
  readonly root: string;
  /**
   * Directory holding the unpacked release. The version is in its name, so
   * installing a different pin adds a directory rather than overwriting the
   * binary a running server was started from.
   */
  readonly binDir: string;
  readonly binaryPath: string;
  readonly licensePath: string;
  readonly noticesPath: string;
  /** Directory loreserver is pointed at with `--config`. */
  readonly configDir: string;
  /** The file Hub generates inside `configDir`. */
  readonly configPath: string;
  readonly immutableStoreDir: string;
  readonly mutableStoreDir: string;
  readonly logDir: string;
  /** File collecting loreserver's stdout and stderr. */
  readonly logPath: string;
}

/**
 * Derive every path from a storage root.
 *
 * The root is resolved against the working directory, so a relative path on a
 * command line becomes absolute here rather than being resolved again, and
 * differently, by a child process with a different working directory.
 */
export function instanceLayout(
  root: string,
  binaryName: string,
  version: string = LORESERVER_VERSION,
): InstanceLayout {
  const absoluteRoot = resolve(root);
  const binDir = join(absoluteRoot, "bin", `loreserver-${version}`);
  const instanceDir = join(absoluteRoot, "loreserver");
  const configDir = join(instanceDir, "config");
  const logDir = join(absoluteRoot, "logs");

  return {
    root: absoluteRoot,
    binDir,
    binaryPath: join(binDir, binaryName),
    licensePath: join(binDir, LICENSE_FILE_NAME),
    noticesPath: join(binDir, NOTICES_FILE_NAME),
    configDir,
    configPath: join(configDir, "local.toml"),
    immutableStoreDir: join(instanceDir, "store", "immutable"),
    mutableStoreDir: join(instanceDir, "store", "mutable"),
    logDir,
    logPath: join(logDir, "loreserver.log"),
  };
}

/**
 * Render a path for a TOML basic string.
 *
 * Backslash begins an escape sequence inside TOML's double-quoted strings, so
 * a Windows path written verbatim is either a parse error or a different path.
 * Forward slashes avoid the question: loreserver is a Rust program, and the
 * Windows file APIs behind Rust's `Path` accept either separator.
 */
function tomlPath(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * The contents of `local.toml`.
 *
 * The table and key names come from the settings loreserver actually reads;
 * an unrecognised key is ignored silently rather than reported, so a mistake
 * here surfaces as a server that listens somewhere unexpected or stores data
 * somewhere unexpected.
 */
export function renderConfig(layout: InstanceLayout, ports: LoreserverPorts): string {
  return [
    "[immutable_store.local]",
    `path = "${tomlPath(layout.immutableStoreDir)}"`,
    "[mutable_store.local]",
    `path = "${tomlPath(layout.mutableStoreDir)}"`,
    "[server.grpc]",
    `port = ${ports.dataPort}`,
    "[server.quic]",
    `port = ${ports.dataPort}`,
    "[server.http]",
    `port = ${ports.healthPort}`,
    "",
  ].join("\n");
}

/**
 * Create the directories loreserver needs and write its configuration.
 *
 * The file is rewritten on every run: it is Hub's output, not an operator's,
 * and an edit made to it by hand would otherwise survive a change of ports
 * made on the command line.
 */
export async function writeInstance(
  layout: InstanceLayout,
  ports: LoreserverPorts,
): Promise<void> {
  for (const directory of [
    layout.configDir,
    layout.immutableStoreDir,
    layout.mutableStoreDir,
    layout.logDir,
  ]) {
    await mkdir(directory, { recursive: true });
  }
  await writeFile(layout.configPath, renderConfig(layout, ports), "utf8");
}
