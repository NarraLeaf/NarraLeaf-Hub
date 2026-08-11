# NarraLeaf Hub

A self-hosted project server for teams working in NarraLeaf Studio. One
organisation runs one Hub on its own machine; there is no hosted service to sign
up for, and no web interface.

Hub is meant to take on four jobs:

- **Supervise `loreserver`.** Hub owns a pinned copy of the `loreserver` binary,
  starts it, keeps it running and controls which version is in use, so that no
  operator has to manage that process by hand.
- **Issue identity.** Studio installations authenticate to Hub, which hands out
  the tokens they present when reaching a project.
- **Track projects and access.** Hub records which projects exist on the server
  and which people are allowed to reach each one.
- **Provide an operator's view.** A terminal interface for running the server,
  plus a read-only overview of the projects it holds.

## Status

This repository currently contains the executable's skeleton: argument parsing,
the build, the tests and continuous integration. None of the four jobs above is
implemented.

Not yet implemented:

- supervision, pinning and upgrading of the `loreserver` binary
- token issuing and any form of authentication
- the project registry and per-project access control
- the terminal interface and the project overview
- server configuration, storage and logging
- anything a NarraLeaf Studio client could usefully connect to

## Requirements

Node.js 22 or newer.

## Building and running

```sh
npm install
npm run build
node dist/nlhub.js --help
```

`npm run build` bundles `src/nlhub.ts` into `dist/nlhub.js`, a single executable
file with a `#!/usr/bin/env node` line. The version number is written into the
bundle as it is built, so the finished file does not depend on a `package.json`
sitting beside it.

The `bin` entry names the executable `nlhub`, so `npm link` puts a working
`nlhub` command on the path during development.

## Development

| Command             | What it does                                          |
| ------------------- | ----------------------------------------------------- |
| `npm run build`     | Bundle the executable into `dist/`                    |
| `npm run dev`       | Rebuild whenever a source file changes                |
| `npm run typecheck` | Check types without emitting anything                 |
| `npm test`          | Run the test suite once                               |

There are no runtime dependencies, and the intention is to keep it that way.
