// Bundles src/nlhub.ts into a single executable file, dist/nlhub.js.
//
// Run with `--watch` to rebuild whenever a source file changes.
import { chmod, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outfile = join(root, "dist", "nlhub.js");

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: [join(root, "src", "nlhub.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  // A shell needs this first line to run the file directly. It is added here
  // rather than in the TypeScript source so that the checker and the test
  // runner never have to make sense of a line that is not JavaScript.
  banner: { js: "#!/usr/bin/env node" },
  // Replaces the identifier throughout the bundle with a literal, so the
  // finished executable carries its own version number. src/version.ts explains
  // why the number is not read from disk at startup.
  define: { __NLHUB_VERSION__: JSON.stringify(manifest.version) },
};

/**
 * Give the output the owner-execute bit, so that a POSIX shell will run
 * dist/nlhub.js through the shebang line. Windows ignores the mode; the call
 * still succeeds there, so it needs no guard.
 */
async function makeExecutable() {
  await chmod(outfile, 0o755);
}

if (process.argv.includes("--watch")) {
  const context = await esbuild.context({
    ...options,
    plugins: [
      {
        name: "chmod-output",
        setup(build) {
          build.onEnd(async (result) => {
            if (result.errors.length === 0) {
              await makeExecutable();
            }
          });
        },
      },
    ],
  });
  await context.watch();
  console.log(`watching for changes; writing ${outfile}`);
} else {
  await esbuild.build(options);
  await makeExecutable();
  console.log(`wrote ${outfile}`);
}
