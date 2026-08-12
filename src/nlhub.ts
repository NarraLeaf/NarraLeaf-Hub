/**
 * Entry point of the `nlhub` executable. The build bundles this file into
 * dist/nlhub.js and gives it a `#!/usr/bin/env node` line.
 *
 * Everything here is process wiring; the behaviour lives in ./cli.ts.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { run } from "./cli.js";

/**
 * The Hub a bare `nlhub` opens the terminal interface on, if there is one.
 *
 * `NLHUB_ROOT` first, then the working directory, and only when it already
 * holds a Hub: opening the database is what creates it, and a bare `nlhub`
 * typed in somebody's home directory must not leave a hub.db behind in it.
 *
 * Both streams have to be a terminal. `nlhub | less` and `nlhub > notes` are
 * asking for text, and an interface would give them a screenful of escape
 * sequences instead of the usage they expected.
 */
function impliedRoot(): string | undefined {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    return undefined;
  }
  const named = process.env["NLHUB_ROOT"];
  if (named !== undefined && named !== "") {
    return named;
  }
  const here = process.cwd();
  return existsSync(join(here, "hub.db")) ? here : undefined;
}

const argv = process.argv.slice(2);
const implied = argv.length === 0 ? impliedRoot() : undefined;

// A command that runs until it is stopped needs to hear about Ctrl-C. Handling
// the signal rather than letting it kill the process is what allows loreserver
// to be shut down before Hub exits; installing a handler also suppresses
// node's default of terminating at once, so the handler must always lead to
// the program ending by itself.
const interrupted = new AbortController();
const interrupt = (): void => {
  interrupted.abort();
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

// Setting `exitCode` rather than calling `process.exit` lets node drain stdout
// before the process ends. `process.exit` can truncate output when the stream
// is a pipe, which is exactly the case when another program reads --version.
process.exitCode = await run(
  implied === undefined ? argv : ["--root", implied],
  (text) => {
    process.stdout.write(text);
  },
  (text) => {
    process.stderr.write(text);
  },
  { signal: interrupted.signal },
);

// Nothing is listening for these any more, and a registered handler would keep
// the process alive after the work is done.
process.off("SIGINT", interrupt);
process.off("SIGTERM", interrupt);
