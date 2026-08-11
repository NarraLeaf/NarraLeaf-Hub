/**
 * Entry point of the `nlhub` executable. The build bundles this file into
 * dist/nlhub.js and gives it a `#!/usr/bin/env node` line.
 *
 * Everything here is process wiring; the behaviour lives in ./cli.ts.
 */
import { run } from "./cli.js";

// Setting `exitCode` rather than calling `process.exit` lets node drain stdout
// before the process ends. `process.exit` can truncate output when the stream
// is a pipe, which is exactly the case when another program reads --version.
process.exitCode = run(
  process.argv.slice(2),
  (text) => {
    process.stdout.write(text);
  },
  (text) => {
    process.stderr.write(text);
  },
);
