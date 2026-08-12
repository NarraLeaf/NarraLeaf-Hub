import { describe, expect, it } from "vitest";

import type { WriteText } from "../src/cli.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { setTokenLifetimes, type TokenLifetimes } from "../src/identity/settings.js";
import { createUser, findUser } from "../src/identity/users.js";
import { userDisable, userRevokeTokens } from "../src/user.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlhub-revoke-");

/** Cheap parameters: these tests are about what is said, not what it costs. */
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);

const PASSWORD = "a password nobody guesses";

/** A storage root holding one account, and whatever a test wants stored. */
async function hubWithAda(lifetimes: Partial<TokenLifetimes> = {}): Promise<string> {
  const root = await temporaryRoot();
  const database = await openMigratedDatabase(identityLayout(root).databasePath);
  try {
    await createUser(database, hasher, { username: "ada", password: PASSWORD });
    setTokenLifetimes(database, lifetimes);
  } finally {
    database.close();
  }
  return root;
}

type Command = (
  options: { readonly root: string; readonly username: string },
  stdout: WriteText,
  stderr: WriteText,
) => Promise<number>;

/** Run one command against a storage root and collect both its streams. */
async function invoke(
  command: Command,
  root: string,
  username = "ada",
): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const code = await command(
    { root, username },
    (text) => {
      out += text;
    },
    (text) => {
      err += text;
    },
  );
  return { code, out, err };
}

describe("user revoke-tokens", () => {
  it("bumps the epoch and leaves the account able to sign in", async () => {
    const root = await hubWithAda();

    const { code } = await invoke(userRevokeTokens, root);

    expect(code).toBe(0);
    const database = await openMigratedDatabase(identityLayout(root).databasePath);
    try {
      const ada = findUser(database, "ada");
      expect(ada?.tokenEpoch).toBe(2);
      // Not disabled, which is the whole of what separates this from disabling:
      // the person signs in again and is given a token that works.
      expect(ada?.disabledAt).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("says how far it reaches, and does not say it reaches further", async () => {
    const root = await hubWithAda();

    const { out } = await invoke(userRevokeTokens, root);

    // Pinned in full. The middle sentence is the one an operator is entitled
    // to: Hub refuses everything it issued, and a connection already open is
    // checked by something Hub is not asked to speak to.
    expect(out).toBe(
      "revoked the tokens of ada\n" +
        "Tokens already issued are refused from now on; a connection already open may last " +
        "until its repository token expires, at most 15 minutes from now.\n" +
        "The account is not disabled, so ada can sign in and be issued a token that works.\n",
    );
  });

  it("states the bound this Hub is set to, not the one it was built with", async () => {
    const root = await hubWithAda({ repositoryTokenLifetimeSeconds: 2 * 60 * 60 });

    const { out } = await invoke(userRevokeTokens, root);

    expect(out).toContain("at most 2 hours from now");
  });

  it("names an account this Hub does not have, and fails", async () => {
    const root = await hubWithAda();

    const { code, out, err } = await invoke(userRevokeTokens, root, "nobody");

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("there is no account called nobody");
  });
});

describe("user disable", () => {
  it("states the same bound, in the unit the setting is written in", async () => {
    const root = await hubWithAda();

    const { code, out } = await invoke(userDisable, root);

    expect(code).toBe(0);
    expect(out).toContain("disabled ada\n");
    expect(out).toContain("tokens already issued are refused from now on");
    // The repository lifetime, said as fifteen minutes. The sign-in lifetime
    // through the same arithmetic would have read "43200 minutes", and it is
    // not the number that bounds this anyway.
    expect(out).toContain("at most 15 minutes from now");
    expect(out).not.toContain("43200");
  });
});
