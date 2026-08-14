import { readFileSync } from "node:fs";

import { defineConfig } from "vitest/config";

// The bundler replaces __NLTEAM_VERSION__ with the version from package.json
// (see scripts/build.mjs). Tests import the same source files, so the identifier
// has to be substituted here too, from the same place, or nothing that reaches
// src/version.ts could run.
const manifest: { version: string } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

// The browser half of the web interface is built into the executable the same
// way, as two string literals (see src/web/assets.ts). A test run does not
// build it — that is a bundler's job and it takes a browser to mean anything —
// so it is stood in for here by a byte of each, which is enough for the router
// tests to exercise serving a file, an entity tag and a 304 without pretending
// a test run has an interface in it.
const PLACEHOLDER_JS = "/* nlteam: not the built interface */\n";
const PLACEHOLDER_CSS = "/* nlteam: not the built styles */\n";

export default defineConfig({
  define: {
    __NLTEAM_VERSION__: JSON.stringify(manifest.version),
    __NLTEAM_WEB_JS__: JSON.stringify(PLACEHOLDER_JS),
    __NLTEAM_WEB_CSS__: JSON.stringify(PLACEHOLDER_CSS),
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
