/**
 * `__NLTEAM_VERSION__` is not a runtime global. Every occurrence of the
 * identifier is replaced with a string literal while the bundle is built, from
 * the `version` field of package.json — see the `define` option in
 * scripts/build.mjs, mirrored in vitest.config.ts so the test run observes the
 * same value the shipped executable would.
 *
 * Baking the number in keeps dist/nlteam.js self-contained: it never has to
 * locate, read or parse a package.json beside itself. Once the file has been
 * installed, copied or symlinked onto a PATH, no such neighbour is guaranteed
 * to exist.
 */
declare const __NLTEAM_VERSION__: string;

/** The version of this build of Team, e.g. `0.1.0`. */
export const VERSION: string = __NLTEAM_VERSION__;
