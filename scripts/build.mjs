// Bundles src/nlteam.ts into dist/nlteam.js.
//
// Two passes, in this order:
//
//   1. The browser half of the web interface — src/web/client — into memory,
//      never onto disk. It is minified, because it crosses a network.
//   2. The executable, with the script and the styles from the first pass
//      substituted into src/web/assets.ts as string literals.
//
// So dist/nlteam.js carries its own pages, the way it already carries its own
// version number, and there is no state in which the server is running and its
// interface is missing, half-built or left over from an older build. It also
// means the server never has to work out where it is on disk to answer a
// request, which is the thing that breaks once a file has been copied,
// symlinked or installed onto a PATH.
//
// Not a self-contained file, and it cannot be one. Reading a repository needs
// koffi, which is a native addon, and lorelib, which is a 29.5 MB shared
// library that arrives as one of four platform packages. Neither can live
// inside a JavaScript bundle, so both are left external and found at runtime
// in node_modules — which is there for `npm i -g`, for a checkout, and inside a
// container. What is no longer possible is copying one file somewhere and
// running it.
//
// Run with `--watch` to rebuild whenever a source file changes.
import { chmod, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outfile = join(root, "dist", "nlteam.js");

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

/**
 * The two browser builds, described but not run.
 *
 * The script and the styles are separate outputs rather than one file with the
 * CSS injected by JavaScript, because the page's content security policy names
 * `style-src 'self'` and no `'unsafe-inline'`. A bundler that wrote the styles
 * into a `<style>` tag at runtime would produce a page the browser refuses to
 * style, and it would refuse it silently.
 *
 * Named separately because watch mode has to watch exactly these files and no
 * others: a change to a page is the one thing that cannot be picked up by
 * rebuilding the executable, since its copy of them is a string literal.
 */
function clientBuilds() {
  const shared = {
    bundle: true,
    write: false,
    format: "esm",
    // What a browser released in the last few years understands. The interface
    // is served by a server its operator installed this year, to people who
    // reach it over TLS, so there is no older browser to carry.
    target: ["es2022", "chrome111", "firefox113", "safari16.4"],
    minify: true,
    sourcemap: false,
    // The interface is written in three languages, and esbuild writes non-ASCII
    // as `\uXXXX` escapes unless told otherwise — six bytes for every Chinese
    // or Japanese character it would otherwise spend three on. The page is
    // served as UTF-8 and says so twice, in its meta tag and in its
    // content-type, so there is nothing for the escapes to protect against.
    charset: "utf8",
    // Nothing in the browser half reads the version, but it imports modules
    // that could, and an identifier left undefined is a build failure rather
    // than something discovered in a browser.
    define: { __NLTEAM_VERSION__: JSON.stringify(manifest.version) },
  };

  return [
    {
      ...shared,
      entryPoints: [join(root, "src", "web", "client", "main.ts")],
      platform: "browser",
      outfile: "app.js",
    },
    {
      ...shared,
      entryPoints: [join(root, "src", "web", "client", "app.css")],
      outfile: "app.css",
    },
  ];
}

/**
 * Build the browser half and answer with its two files, as text.
 *
 * `write: false` is the whole trick: esbuild hands back what it would have
 * written, and the second pass puts it inside the executable. Nothing here
 * touches dist/.
 */
async function buildClient() {
  const [script, styles] = await Promise.all(clientBuilds().map((build) => esbuild.build(build)));
  return { js: script.outputFiles[0].text, css: styles.outputFiles[0].text };
}

/**
 * Everything the executable is built from, with whatever the browser half
 * currently is baked into it.
 *
 * A function rather than a constant so that watch mode can build it again with
 * a freshly built client, which is the one thing a `define` cannot be told to
 * change after the fact.
 *
 * @returns {import("esbuild").BuildOptions}
 */
function serverOptions(client) {
  return {
  entryPoints: [join(root, "src", "nlteam.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  // Both of these are needed by the terminal interface, and both of them fail
  // when the finished file is run rather than when it is built:
  //
  //   - Ink imports react-devtools-core at the top of a module, so an external
  //     import of a package nobody installed reaches the executable and it
  //     dies with ERR_MODULE_NOT_FOUND before drawing anything.
  //   - One of Ink's dependencies calls require("assert"), which an ESM bundle
  //     refuses with "Dynamic require of assert is not supported" unless there
  //     is a require to call.
  //
  // The first line is the one a shell needs to run the file directly; it is
  // added here rather than in the TypeScript source so that the checker and
  // the test runner never have to make sense of a line that is not JavaScript.
  alias: { "react-devtools-core": join(root, "scripts", "devtools-stub.js") },
  // The two that cannot be bundled, for the reason at the top of this file.
  // The platform packages are named as a group because exactly one of the four
  // is ever installed — each declares the os and cpu it is for — and a build on
  // one machine must not decide which one the finished file may look for.
  external: ["koffi", "@lore-vcs/*"],
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __nlteamCreateRequire } from "node:module";',
      "const require = __nlteamCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  // Replaces the identifier throughout the bundle with a literal, so the
  // finished executable carries its own version number. src/version.ts explains
  // why the number is not read from disk at startup, and src/web/assets.ts says
  // the same about the two below.
    define: {
      __NLTEAM_VERSION__: JSON.stringify(manifest.version),
      __NLTEAM_WEB_JS__: JSON.stringify(client.js),
      __NLTEAM_WEB_CSS__: JSON.stringify(client.css),
    },
  };
}

/**
 * Give the output the owner-execute bit, so that a POSIX shell will run
 * dist/nlteam.js through the shebang line. Windows ignores the mode; the call
 * still succeeds there, so it needs no guard.
 */
async function makeExecutable() {
  await chmod(outfile, 0o755);
}

/** Start watching the executable's own sources, and write it once now. */
async function startServerContext(client) {
  const context = await esbuild.context({
    ...serverOptions(client),
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
  return context;
}

if (process.argv.includes("--watch")) {
  // Two watches, because they are two builds and only one of them can be
  // incremental at a time. The server's context holds the browser half inside
  // it as a pair of string literals, so a change to a page means throwing that
  // context away and making another one; a change to anything else is the
  // ordinary incremental rebuild it always was.
  let client = await buildClient();
  let server = await startServerContext(client);

  const clientWatchers = await Promise.all(
    clientBuilds().map((build) =>
      esbuild.context({
        ...build,
        plugins: [
          {
            name: "rebuild-server",
            setup(pass) {
              let first = true;
              pass.onEnd(async (result) => {
                // The first end is this context starting up, and the server was
                // just built from exactly these files.
                if (first) {
                  first = false;
                  return;
                }
                if (result.errors.length > 0) {
                  return;
                }
                client = await buildClient();
                await server.dispose();
                server = await startServerContext(client);
                console.log("rebuilt the web interface");
              });
            },
          },
        ],
      }),
    ),
  );
  await Promise.all(clientWatchers.map((watcher) => watcher.watch()));

  console.log(`watching for changes; writing ${outfile}`);
} else {
  await esbuild.build(serverOptions(await buildClient()));
  await makeExecutable();
  console.log(`wrote ${outfile}`);
}
