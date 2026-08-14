# How Team works

Why the parts are the shape they are. None of it is needed to run a Team server — that is
[operations.md](operations.md).

## Reading what is inside a project

The interface shows a project's revision history and what its project file says.
Neither is in Team's database: both are inside the repository, and Team reads them
the same way a Studio installation on somebody else's machine does — as a client,
over the network, against its own `loreserver`.

That is not a preference. `loreserver` holds an exclusive lock on the store it
is serving, and opening it a second time does not fail: it waits, at no CPU,
with nothing logged and no timeout to reach. So Team clones each project into
`<root>/cache/projects/<repository id>/` and reads that instead.

A checkout there holds no files at all. The clone is bare, which costs nothing
on the wire and a couple of kilobytes on disk; the branch, the history and each
revision's metadata are then answered from disk, and the revision tree — every
directory, every file and every size — and the contents of any file in it are
read through the store, which fetches what it needs on demand. Measured against
a project whose latest revision runs to 12 MB: 240 ms to clone and read the
first time, 90 ms to refresh, and 5.7 KB of cache.

**The cache is disposable.** Deleting `<root>/cache` at any moment, in whole or
in part, costs the time of the next read and nothing else. Nothing is kept there
that is not also in the repository it came from.

Reading happens beside the interface rather than in front of it. The screen is
drawn from the database at once and each project's history and file replace the
word unknown as they arrive, so a slow or stopped `loreserver` costs freshness
and nothing else.

What Team takes from a project file is its title, its stage size, how many scenes
there are, and how many assets of each kind and how large. It reads no further:
what a scene means belongs to Studio, and a Team server that had to know it would be a
Team that had to be upgraded whenever Studio was.

Anything Team cannot make sense of becomes a sentence rather than an error. A
project file from a newer Studio, one that was only half written, one that is
not the shape its name claims, a project nobody has pushed to, a repository that
cannot be reached — each of them leaves the parts Team did understand on screen
and says in words what it could not read.

## The authorization service

`loreserver` does not decide who may touch a repository. It asks, over gRPC, at
the address in its `auth_url`, forwarding the caller's own `authorization`
header. That address is Team.

```
epic_urc.UrcAuthApi/CheckUserPermission     may this caller reach these?
epic_urc.UrcAuthApi/LookupUserPermissions   what may this caller reach?
epic_urc.UrcAuthApi/ExchangeExternalTokenForUserToken       sign in
epic_urc.UrcAuthApi/ExchangeUserTokenForMultiresourceToken  a token for the data connection
ucs.auth.RebacApi/CreateResource            a repository now exists
ucs.auth.RebacApi/DeleteResource            a repository is gone
```

The same methods are served twice: on 41402 over TLS, which is what a client and
a Team server-supervised `loreserver` both reach, and on 41401 in plain HTTP/2 on the
loopback, which is what a `loreserver` that cannot be given Team's authority can
be pointed at instead. Neither listener is given anything the other is not —
every method decides from the token it was presented, not from where the
connection came.

Team identifies the caller by verifying the token against its own signing keys,
and answers with the projects that caller has a grant on. A token that is
expired, altered, from a disabled account, or issued before that account's
access was revoked is refused, and a refusal reaches the person as "not found" —
`loreserver` tells a client nothing about why. Every decision is written to
Team's log with the caller, the resource and the outcome, and kept in `team.db`
where something other than the terminal `up` is running in can read it —
`loreserver` records that it asked, not what it was told, so this is the only
account of who reached what.

The kept decisions are bounded, at two thousand rows. A count rather than an
age: a Team server used twice a month would have its whole history deleted between
visits by an age bound, while a busy one would keep hundreds of thousands of
rows inside any window worth calling recent. When the bound has to choose, it
drops the oldest allowances first and refusals last — an allowance is what every
working access produces, and a refusal is the row somebody comes looking for.
The trim runs once in every few hundred decisions rather than on each one, and a
decision is written without waiting for the disk, so answering a permission
question is not a Team server waiting on a platter.

This is also what makes revocation immediate, and it is the part `loreserver`
alone cannot do: it checks a token's signature and its expiry, and asks nothing
else, but every repository access goes on to ask Team.

## The interface is a second host, not a second implementation

The interface carries nothing out itself. A key that changes something names
what it wants, and that is met by calling exactly what the command of the same
name calls: `d` reaches `disableUser`, `x` reaches `revokeUserTokens`, `i`
reaches `createInvite`. What each one answers with says the same thing the
command prints, including how far it reaches — `x` says that a connection
already open may last until its repository token expires, because "every token"
is otherwise read as including a session somebody has open.

Three keys name a command instead of doing anything, and that is deliberate:
`n`, `g` and `r` need a project's name or an account to grant to, which the
interface has no way to ask for. Opening a window that pretended to do it would
not be honest.

Everything drawn arrives in one read-only structure, `src/tui/teamview.ts`,
gathered by `src/view.ts`. Nothing under `src/tui/` opens the database or a
repository, and there are assertions that say so. What Team cannot work out
arrives absent and is drawn as "unknown" rather than as an error or a zero — a
project written by a newer Studio shows the parts Team understands and the word
unknown for the rest, which is what keeps Team from having to be upgraded in step
with Studio. Absent and zero are different facts and are drawn differently: a
project with no revisions reads `0`, `—` and `never`, one nobody has counted
reads `?` and `unknown`.

## What the build produces

`npm run build` bundles `src/nlteam.ts` into `dist/nlteam.js`, an executable file
with a `#!/usr/bin/env node` line. The version number is written into the bundle
as it is built, so the finished file does not depend on a `package.json` sitting
beside it.

It is no longer a self-contained file, and it cannot be one. Reading a
repository needs `koffi`, a native addon, and `lorelib`, a 29.5 MB shared
library that arrives as one of four platform packages — Epic publish one per
platform, each declaring the `os` and `cpu` it is for, so installing puts
exactly one of them on disk. Neither can live inside a JavaScript bundle, so
both are left external and found at runtime in `node_modules`. That is there for
`npm i -g`, for a checkout, and inside a container; what stops being possible is
copying `dist/nlteam.js` somewhere on its own and running it. Everything except
reading a repository still works without them, and Team says which projects it
could not read rather than refusing to start.

`LORE_LIB_PATH` names a `lorelib` to load instead, and skips the platform check
on purpose: it is there for a machine Epic publishes no build for, where
somebody who built the library themselves should be able to point Team at it.

The `bin` entry names the executable `nlteam`, so `npm link` puts a working
`nlteam` command on the path during development.

## What Team redistributes, and under what terms

`up` keeps Epic Games' `LICENSE.txt` and `THIRD-PARTY-NOTICES.txt` beside every
binary it installs: `loreserver`'s come out of the release archive it was
unpacked from, and `lorelib`'s are fetched from its own release archive into
`lorelib-<version>/` in the same per-user cache. The library itself comes from
npm, and its package lists both files among its `files` while shipping neither —
checked against 0.8.6, where the published tarball holds the library, two entry
points and a README. Fetching them is not a precondition of anything: a machine
that cannot reach GitHub says so once and carries on.


## What is written here, and what is not


The runtime dependencies are Ink and React for the terminal interface, and
`koffi` with one `@lore-vcs/sdk-*` platform package for reading a repository.
Everything else is written here. That includes the binding to `lorelib`:
`src/lore/` is the slice of Epic's C ABI Team uses, a loader, an event decoder
and a dozen verbs, none of which writes anything. It includes gRPC, which Team
both serves and calls: `src/grpc/` is the protocol buffer codec, the framing, a
server and a client, on `node:http2`, for the dozen small messages `loreserver`
and Team exchange. It includes reading MessagePack, which is what a Studio
project file is written in. And it includes X.509:
`src/tls/` writes the DER of a certificate a byte at a time, and `node:crypto`
signs it.

## Tests and the interface driver

`scripts/tui-drive.mjs` runs the built executable's interface through a real
pseudo-terminal and prints the grid a person would be looking at, one frame per
key. It is a mechanical driver: it captures, it does not judge. It needs
`node-pty` and `@xterm/headless`, which are not dependencies of this package —
install them for a checkout with
`npm install --no-save --no-package-lock node-pty @xterm/headless`, and it says
so if they are missing.

```sh
node scripts/build.mjs
node scripts/tui-drive.mjs --root /srv/team --columns 120 --rows 40 --keys 2,down,x
```

The certificate tests are worth knowing about before changing anything under
`src/tls/`. They read what the writer produced back with
`crypto.X509Certificate`, compare the extensions against the exact bytes DER
allows for them, and complete a real TLS handshake between a server holding the
generated pair and a client holding the authority. A certificate that only looks
right is worth nothing.

`npm test` downloads nothing and contacts nothing outside the machine. The tests
that need a real `loreserver` — the whole lifecycle, and reading a project while
the server holds its store — are skipped unless `NLTEAM_TEST_LORESERVER_ROOT`
names a directory they may install into:

```sh
NLTEAM_TEST_LORESERVER_ROOT=/tmp/nlteam-it npm test
```

Reading covers more when `NLTEAM_TEST_LORE_CLI` also names Epic's `lore`
executable: with it the test puts a project into a repository and reads it back,
which is the half of it a repository nobody has pushed to cannot reach. Team
binds no verb that writes a revision and is not going to grow one for a test.

```sh
NLTEAM_TEST_LORESERVER_ROOT=/tmp/nlteam-it NLTEAM_TEST_LORE_CLI=/opt/lore/lore npm test
```
