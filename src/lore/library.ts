/**
 * Loading lorelib and binding the verbs Hub uses.
 *
 * The one property of this module that matters more than any other: **nothing
 * happens at module evaluation.** `koffi.load()` runs inside
 * {@link loadLoreLibrary}, never at import.
 *
 * A module that throws while it is being evaluated is cached as failed by node
 * for the life of the process. If the load were at the top of this file, one
 * static import anywhere in the reachable graph would take the whole program
 * down at startup on a machine with no native build for it — and an operator
 * who then installed the missing package would still get the same failure
 * until they restarted. Here a failed load is a thrown error at a call site,
 * and the next call after a repair succeeds.
 *
 * `koffi` itself is a safe import: it is an ordinary prebuilt addon that knows
 * nothing about Lore. Only `koffi.load(<lorelib>)` can fail for platform
 * reasons.
 */
import { createRequire } from "node:module";

import koffi from "koffi";

import {
  LORE_ALIASES,
  LORE_CALLBACK_CONFIG,
  LORE_CALLBACK_PROTOTYPE,
  LORE_STRUCTS,
  LORE_STRUCT_ALIASES,
  LORE_VERBS,
  type LoreVerbName,
} from "./abi.js";

/**
 * Which package carries the shared library, by host.
 *
 * Each one declares `os` and `cpu` in its manifest, so an install puts exactly
 * one of the four on disk and the other three are skipped rather than
 * downloaded and ignored. That is also why they are optional dependencies: a
 * host Epic ships no build for still installs Hub, and finds out at the point
 * it tries to read a repository rather than at the point it runs anything.
 */
const PLATFORM_PACKAGES: Readonly<Record<string, string>> = {
  "win32-x64": "@lore-vcs/sdk-amd64-unknown-windows",
  "darwin-arm64": "@lore-vcs/sdk-arm64-apple-darwin",
  "linux-x64": "@lore-vcs/sdk-amd64-unknown-linux",
  // Built for Neoverse cores with 512-bit SVE, the same constraint the
  // loreserver pin records for its own 64-bit ARM Linux build.
  "linux-arm64": "@lore-vcs/sdk-arm64-graviton-linux",
};

/** The environment variable that names a library Hub did not install. */
export const LIBRARY_PATH_VARIABLE = "LORE_LIB_PATH";

/** Raised when the shared library could not be found or loaded. */
export class LoreLibraryError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LoreLibraryError";
  }
}

/** Raised when this build of lorelib does not export a symbol Hub binds. */
export class LoreCapabilityError extends Error {
  constructor(
    readonly verb: LoreVerbName,
    readonly symbol: string,
    override readonly cause?: unknown,
  ) {
    super(`this build of lorelib does not export ${symbol}, which ${verb} needs`);
    this.name = "LoreCapabilityError";
  }
}

/**
 * `int32_t f(const LoreGlobalArgs*, const LoreXArgs*, LoreEventCallbackConfig)`,
 * plus koffi's `.async` variant, which runs the call on a worker thread.
 */
export interface LoreVerbFunction {
  (globals: object, args: object, callback: object): number;
  async(
    globals: object,
    args: object,
    callback: object,
    done: (error: Error | null, result: number) => void,
  ): void;
}

export interface LoreLibrary {
  /** Absolute path of the loaded shared library. */
  readonly path: string;
  /** A bound verb, or a typed error if this build lacks its symbol. */
  verb(name: LoreVerbName): LoreVerbFunction;
  /** The koffi type handle for a registered struct, for decoding payloads. */
  type(name: string): koffi.IKoffiCType;
  /** The registered `LoreEventCallbackFunction` pointer type. */
  readonly callbackPrototype: koffi.IKoffiCType;
}

/** The `${platform}-${arch}` pairs a build of lorelib is published for. */
export function supportedLibraryTargets(): string[] {
  return Object.keys(PLATFORM_PACKAGES);
}

/**
 * Where the shared library is.
 *
 * `LORE_LIB_PATH` wins and skips the platform check on purpose: it is there for
 * hosts Epic publishes no build for, where somebody who built lorelib
 * themselves should be able to point Hub at it rather than be told their
 * machine is unsupported by a table.
 */
export function resolveLibraryPath(): string {
  const override = process.env[LIBRARY_PATH_VARIABLE];
  if (override !== undefined && override !== "") {
    return override;
  }

  const target = `${process.platform}-${process.arch}`;
  const packageName = PLATFORM_PACKAGES[target];
  if (packageName === undefined) {
    throw new LoreLibraryError(
      `no lorelib build is published for ${target}. Hub can read repositories on ` +
        `${supportedLibraryTargets().join(", ")}; elsewhere, build lorelib and name it ` +
        `in ${LIBRARY_PATH_VARIABLE}.`,
    );
  }

  try {
    // The platform package's default export IS the absolute library path.
    const resolved: unknown = createRequire(import.meta.url)(packageName);
    const path =
      typeof resolved === "string" ? resolved : (resolved as { default?: unknown } | null)?.default;
    if (typeof path !== "string") {
      throw new LoreLibraryError(`${packageName} did not export a library path`);
    }
    return path;
  } catch (error) {
    if (error instanceof LoreLibraryError) {
      throw error;
    }
    throw new LoreLibraryError(
      `cannot find ${packageName}, so this installation cannot read a repository. ` +
        "It is an optional dependency; installing Hub's dependencies again is what puts it back.",
      error,
    );
  }
}

/**
 * koffi's type registry is process-global and refuses a duplicate name, so the
 * types are registered exactly once even when loading is retried after a
 * repair.
 */
let registered: {
  types: Map<string, koffi.IKoffiCType>;
  callbackPrototype: koffi.IKoffiCType;
} | null = null;

function registerTypes(): NonNullable<typeof registered> {
  if (registered !== null) {
    return registered;
  }

  const types = new Map<string, koffi.IKoffiCType>();

  for (const [name, target] of Object.entries(LORE_ALIASES)) {
    types.set(name, koffi.alias(name, target));
  }
  for (const [name, fields] of Object.entries(LORE_STRUCTS)) {
    types.set(name, koffi.struct(name, { ...fields }));
    // A struct alias has to follow the struct it points at. Declaring them
    // here makes that ordering a property of the data rather than of a second
    // loop somebody could move.
    for (const [alias, target] of Object.entries(LORE_STRUCT_ALIASES)) {
      if (target === name) {
        types.set(alias, koffi.alias(alias, target));
      }
    }
  }

  const callbackPrototype = koffi.proto(LORE_CALLBACK_PROTOTYPE.name, LORE_CALLBACK_PROTOTYPE.returns, [
    ...LORE_CALLBACK_PROTOTYPE.args,
  ]);
  types.set(
    "LoreEventCallbackConfig",
    koffi.struct("LoreEventCallbackConfig", { ...LORE_CALLBACK_CONFIG }),
  );

  registered = { types, callbackPrototype };
  return registered;
}

let library: LoreLibrary | null = null;

/**
 * Load lorelib and bind Hub's verbs.
 *
 * Verbs are bound on demand and remembered: `lib.func` throws when a symbol is
 * absent, and binding at load time would turn one missing symbol into a
 * library that cannot be used at all. A failed load is not latched — the
 * caller decides whether to try again.
 */
export function loadLoreLibrary(): LoreLibrary {
  if (library !== null) {
    return library;
  }

  const path = resolveLibraryPath();
  const { types, callbackPrototype } = registerTypes();

  let loaded: koffi.IKoffiLib;
  try {
    loaded = koffi.load(path);
  } catch (error) {
    throw new LoreLibraryError(`cannot load the version control library at ${path}`, error);
  }

  const bound = new Map<LoreVerbName, LoreVerbFunction | LoreCapabilityError>();

  const bind = (name: LoreVerbName): LoreVerbFunction | LoreCapabilityError => {
    const cached = bound.get(name);
    if (cached !== undefined) {
      return cached;
    }
    const { symbol, args } = LORE_VERBS[name];
    let result: LoreVerbFunction | LoreCapabilityError;
    try {
      result = loaded.func(symbol, "int32_t", [
        koffi.pointer("LoreGlobalArgs"),
        koffi.pointer(args),
        "LoreEventCallbackConfig",
      ]) as unknown as LoreVerbFunction;
    } catch (error) {
      result = new LoreCapabilityError(name, symbol, error);
    }
    bound.set(name, result);
    return result;
  };

  library = {
    path,
    verb(name) {
      const result = bind(name);
      if (result instanceof LoreCapabilityError) {
        throw result;
      }
      return result;
    },
    type(name) {
      const type = types.get(name);
      if (type === undefined) {
        throw new LoreLibraryError(`the type ${name} is not registered`);
      }
      return type;
    },
    callbackPrototype,
  };
  return library;
}

/**
 * Forget the loaded library so the next call loads it again.
 *
 * The registered koffi types are deliberately kept: they are process-global,
 * and registering them twice throws.
 */
export function forgetLoreLibrary(): void {
  library = null;
}
