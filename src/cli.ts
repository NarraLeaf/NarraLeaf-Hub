import { parseArgs } from "./args.js";
import { DEFAULT_IDENTITY } from "./identity/config.js";
import { inviteCreate } from "./invite.js";
import { keyList, keyRotate } from "./key.js";
import { DEFAULT_PORTS } from "./loreserver/layout.js";
import { tokenMint } from "./token.js";
import { up } from "./up.js";
import { userCreate, userDisable, userEnable, userList } from "./user.js";
import { VERSION } from "./version.js";

/**
 * Somewhere to send a chunk of already-formatted output. `process.stdout.write`
 * satisfies it; a test can pass a function that appends to an array instead,
 * which is why `run` takes its two streams as parameters rather than reaching
 * for the process globals.
 */
export type WriteText = (text: string) => void;

/** Anything a command needs that does not come from the command line. */
export interface RunOptions {
  /**
   * Aborted when the operator interrupts the program. Commands that run until
   * stopped watch it; the rest ignore it.
   */
  readonly signal?: AbortSignal;
}

/** The text `--help` prints. */
export const USAGE = `Usage: nlhub <command> [options]

NarraLeaf Hub is a self-hosted project server for teams using NarraLeaf Studio.

Commands:
  up                        Install and run loreserver, and serve Hub's endpoint
  invite create             Make an invite code, and print it once
  user list                 List the accounts
  user create <username>    Redeem an invite code into an account
  user disable <username>   Stop an account being issued anything new
  user enable <username>    Let an account sign in again
  token mint <username>     Sign a token for an account
  key list                  Show the signing keys
  key rotate                Generate a key and sign with it from now on

Every command takes --root <path>, the directory Hub keeps its files in.

Options for up:
      --data-port <port>    gRPC and QUIC port (default ${DEFAULT_PORTS.dataPort})
      --health-port <port>  loreserver's HTTP health check port (default ${DEFAULT_PORTS.healthPort})
      --identity            Configure loreserver to demand a Hub token

Options for invite create:
      --role <name>         Group the account joins (default member)
      --expires <duration>  How long the code lasts, e.g. 48h (default 7d)

Options for user create:
      --display-name <name> Name shown to other people
      --email <address>
      --service-account     Mark the account as one no person signs in to

Identity options, taken by up and token mint:
      --hub-port <port>     Hub's own HTTP port (default ${DEFAULT_IDENTITY.hubPort})
      --issuer <name>       Token issuer (default ${DEFAULT_IDENTITY.issuer})
      --audience <name>     Audience loreserver requires (default ${DEFAULT_IDENTITY.audience})
      --auth-origin <host>  Host clients authenticate against, without a scheme
                            (default ${DEFAULT_IDENTITY.authOrigin})
      --env <name>          Environment claim (default ${DEFAULT_IDENTITY.env})
      --idp <name>          Identity provider claim (default ${DEFAULT_IDENTITY.idp})
      --token-lifetime <duration>
                            How long a token lasts (default ${DEFAULT_IDENTITY.tokenLifetimeSeconds / 60}m)

Options:
  -v, --version    Print the version and exit
  -h, --help       Print this message and exit

user create and token mint read the password from standard input.

up runs until it is interrupted, and stops loreserver on its way out.`;

/**
 * Carry out one command line and return the process exit code.
 *
 * `--version` prints the bare version and nothing else, so that a script can
 * read it without having to strip a label off the front.
 */
export async function run(
  argv: readonly string[],
  stdout: WriteText,
  stderr: WriteText,
  options: RunOptions = {},
): Promise<number> {
  const invocation = parseArgs(argv);

  switch (invocation.kind) {
    case "version":
      stdout(`${VERSION}\n`);
      return 0;
    case "help":
      stdout(`${USAGE}\n`);
      return 0;
    case "up":
      return await up(
        {
          root: invocation.root,
          dataPort: invocation.dataPort,
          healthPort: invocation.healthPort,
          identity: invocation.identity,
          overrides: invocation.overrides,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        stdout,
        stderr,
      );
    case "invite-create":
      return await inviteCreate(
        { root: invocation.root, role: invocation.role, lifetimeMs: invocation.lifetimeMs },
        stdout,
        stderr,
      );
    case "user-list":
      return await userList({ root: invocation.root }, stdout, stderr);
    case "user-create":
      return await userCreate(
        {
          root: invocation.root,
          username: invocation.username,
          code: invocation.code,
          displayName: invocation.displayName,
          email: invocation.email,
          isServiceAccount: invocation.isServiceAccount,
        },
        stdout,
        stderr,
      );
    case "user-disable":
      return await userDisable(
        { root: invocation.root, username: invocation.username },
        stdout,
        stderr,
      );
    case "user-enable":
      return await userEnable(
        { root: invocation.root, username: invocation.username },
        stdout,
        stderr,
      );
    case "token-mint":
      return await tokenMint(
        {
          root: invocation.root,
          username: invocation.username,
          overrides: invocation.overrides,
        },
        stdout,
        stderr,
      );
    case "key-list":
      return await keyList({ root: invocation.root }, stdout, stderr);
    case "key-rotate":
      return await keyRotate({ root: invocation.root }, stdout, stderr);
    case "error":
      // Prefix the program name the way command line tools conventionally do,
      // so the line still identifies its source in a wall of build output.
      stderr(`nlhub: ${invocation.message}\n`);
      return 2;
  }
}
