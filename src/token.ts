/**
 * The `token mint` command: sign a token for somebody who has proved who they
 * are.
 *
 * The password is checked first, through the same path a sign-in would take,
 * rather than the command minting for any name it is given. Whoever runs this
 * already has the storage root and could sign anything they liked with the key
 * in it, so this is not a barrier — it is the only exercise the sign-in path
 * gets until there is an endpoint in front of it, and a command that skipped it
 * would let that path rot unnoticed.
 *
 * The token goes to standard output on its own, so a script can capture it. The
 * description of what was minted goes to standard error, where it does not end
 * up inside an Authorization header.
 */
import type { WriteText } from "./cli.js";
import { identityConfig, type IdentityConfig } from "./identity/config.js";
import { openMigratedDatabase } from "./identity/database.js";
import { KeyStore } from "./identity/keys.js";
import { identityLayout } from "./identity/layout.js";
import { defaultPasswordHasher } from "./identity/passwords.js";
import { mintToken } from "./identity/tokens.js";
import { authenticate, SIGN_IN_REFUSED_MESSAGE } from "./identity/users.js";
import { readPassword } from "./stdin.js";

export interface TokenMintOptions {
  readonly root: string;
  readonly username: string;
  readonly overrides: Partial<IdentityConfig>;
}

/** Mint one token. Returns the process exit code. */
export async function tokenMint(
  options: TokenMintOptions,
  stdout: WriteText,
  stderr: WriteText,
): Promise<number> {
  const layout = identityLayout(options.root);
  const config = identityConfig(options.overrides);

  let password: string;
  try {
    password = await readPassword();
  } catch (error) {
    stderr(`nlhub: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const database = await openMigratedDatabase(layout.databasePath);
  try {
    const result = await authenticate(
      database,
      defaultPasswordHasher(),
      options.username,
      password,
    );
    if (result.kind === "refused") {
      // One sentence for every way it can fail. The reason is in the result
      // for a caller that logs it; the person at the keyboard is told nothing
      // they could use to find out which accounts exist.
      stderr(`nlhub: ${SIGN_IN_REFUSED_MESSAGE}\n`);
      return 1;
    }

    const keys = await KeyStore.open(layout.keysDir);
    const minted = mintToken(result.user, keys.signingKey, config);

    stdout(`${minted.token}\n`);
    stderr(`header ${JSON.stringify(minted.header, null, 2)}\n`);
    stderr(`claims ${JSON.stringify(minted.claims, null, 2)}\n`);
    stderr(`expires ${new Date(minted.claims.exp * 1000).toISOString()}\n`);
    return 0;
  } catch (error) {
    stderr(`nlhub: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}
