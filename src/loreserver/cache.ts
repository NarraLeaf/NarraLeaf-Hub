/**
 * Where the binaries Team downloads are kept.
 *
 * They used to be kept under the storage root, one copy per Team, which meant
 * one copy per test run and one per throwaway instance. On Windows that is not
 * merely wasteful: a firewall prompt is raised the first time a program at a
 * given path binds a port, and the rule it writes names that path. A machine
 * that has run the test suite a few times ends up with dozens of copies of one
 * executable and twice as many rules, each allowing one throwaway path inbound.
 * Nothing ever removes them, and the storage roots they name are long gone.
 *
 * So a downloaded binary goes where a program's own downloads go on each
 * platform, once per user and once per version. The storage root keeps
 * everything that is about one Team server — the configuration, the store, the
 * database, the keys and the certificates — and nothing that is about a
 * release.
 *
 * The version is in the directory name, so two versions sit side by side and
 * installing a different pin adds a directory rather than overwriting the
 * binary a running server was started from.
 */
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * The variable that names a directory to use instead of the per-user cache.
 *
 * A container image wants the binaries baked in at a path known when the image
 * is built, with no per-user directory to depend on and nothing to download at
 * run time. Anything named here is used exactly as given.
 */
export const CACHE_DIRECTORY_ENV = "NLTEAM_CACHE_DIR";

/** The directory name Team takes for itself inside a shared cache location. */
const APPLICATION = "nlteam";

/** What one machine and one user keep their downloads in. */
export function binariesCacheDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  home: string = homedir(),
): string {
  const named = env[CACHE_DIRECTORY_ENV];
  if (named !== undefined && named !== "") {
    return resolve(named);
  }

  if (platform === "win32") {
    // `%LOCALAPPDATA%` rather than `%APPDATA%`: a downloaded binary is
    // machine-local and has no business following a roaming profile across
    // machines, where it would be the wrong architecture as often as not.
    const local = env["LOCALAPPDATA"];
    const base = local === undefined || local === "" ? join(home, "AppData", "Local") : local;
    return join(base, APPLICATION, "cache");
  }

  if (platform === "darwin") {
    return join(home, "Library", "Caches", APPLICATION);
  }

  // The XDG base directory specification says a relative `XDG_CACHE_HOME` is
  // to be ignored, which matters here: resolving one against the working
  // directory would put the binaries wherever the operator happened to be
  // standing when they started Team.
  const xdg = env["XDG_CACHE_HOME"];
  const base = xdg === undefined || xdg === "" || !isAbsolute(xdg) ? join(home, ".cache") : xdg;
  return join(base, APPLICATION);
}

/**
 * Where one release of one program is unpacked.
 *
 * `bin` is kept between the cache and the version, so that anything else Team
 * ever caches has somewhere to go that is not among the executables.
 */
export function cachedInstallDir(
  program: string,
  version: string,
  cacheDir: string = binariesCacheDir(),
): string {
  return join(cacheDir, "bin", `${program}-${version}`);
}

/**
 * Where a Team server older than this change put the same directory.
 *
 * Still derived, and still read, because an installation that already has the
 * binary there goes on using it — see src/loreserver/install.ts for why it is
 * used where it lies rather than moved.
 */
export function storedInstallDir(root: string, program: string, version: string): string {
  return join(resolve(root), "bin", `${program}-${version}`);
}
