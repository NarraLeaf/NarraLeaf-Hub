import { createPublicKey, createVerify } from "node:crypto";

import { describe, expect, it } from "vitest";

import { identityConfig } from "../src/identity/config.js";
import { KeyStore, type JwksDocument } from "../src/identity/keys.js";
import { identityLayout } from "../src/identity/layout.js";
import { decodeToken, DisabledAccountError, mintToken } from "../src/identity/tokens.js";
import type { UserRecord } from "../src/identity/users.js";
import { ensureCertificates, readAuthority } from "../src/tls/authority.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-tokens-");

const ADA: UserRecord = {
  id: "9a1c0e2e-3b7d-4d2a-8f0e-5b6d7c8e9f00",
  username: "ada",
  displayName: "Ada Lovelace",
  email: "ada@example.com",
  isServiceAccount: false,
  createdAt: 1_700_000_000_000,
  disabledAt: undefined,
  tokenEpoch: 3,
  tokensInvalidatedAt: undefined,
  groups: ["admin", "authors"],
};

async function store(): Promise<KeyStore> {
  return await KeyStore.open(identityLayout(await temporaryRoot()).keysDir);
}

/**
 * Check a token the way loreserver does: against the published JWKS, having
 * never seen the private key.
 *
 * The `kid` in the header chooses the key, which is the whole reason it is
 * there — a verifier holding two published keys must not have to try both.
 */
function verifyAgainstJwks(token: string, jwks: JwksDocument): boolean {
  const [header, claims, signature] = token.split(".");
  if (header === undefined || claims === undefined || signature === undefined) {
    return false;
  }
  const kid = (JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as { kid: string })
    .kid;
  const published = jwks.keys.find((key) => key.kid === kid);
  if (published === undefined) {
    return false;
  }
  const publicKey = createPublicKey({
    key: { kty: published.kty, n: published.n, e: published.e },
    format: "jwk",
  });
  return createVerify("RSA-SHA256")
    .update(`${header}.${claims}`)
    .verify(publicKey, Buffer.from(signature, "base64url"));
}

describe("mintToken", () => {
  it("writes exactly the claims loreserver insists on, and nothing else", async () => {
    const keys = await store();
    const config = identityConfig({
      issuer: "narraleaf-team",
      audience: "loreserver",
      authOrigin: "team.example.com",
    });
    const now = new Date("2026-08-11T09:00:00.000Z");

    const minted = mintToken(ADA, keys.signingKey, config, { now });
    const { header, claims } = decodeToken(minted.token);

    expect(header).toEqual({ alg: "RS256", typ: "JWT", kid: keys.signingKey.kid });
    expect(claims).toEqual({
      iss: "narraleaf-team",
      // Every remote this token may be sent to, in every spelling the client
      // has been seen to compare against. tests/audience.test.ts is where each
      // entry is accounted for.
      aud: [
        "loreserver",
        "https://team.example.com",
        "https://team.example.com/",
        "team.example.com",
        "team.example.com:41337",
        "lore://team.example.com:41337",
        "lore://team.example.com:41337/",
      ],
      sub: ADA.id,
      env: "local",
      name: "Ada Lovelace",
      // The address a client writes into a revision beside the name. Absent
      // from a token for an account that has none recorded, rather than empty.
      email: "ada@example.com",
      preferred_username: "ada",
      groups: ["admin", "authors"],
      is_service_account: false,
      idp: "narraleaf-team",
      iat: 1_786_438_800,
      // Thirty days, because nothing said otherwise and a token minted for
      // anything but a repository's data connection is one Team is asked about
      // again before it can be used for anything.
      exp: 1_786_438_800 + 30 * 24 * 60 * 60,
      // Team's own claim, and the only one loreserver does not read: it is what
      // lets Team refuse a token that was signed before this account's access
      // was revoked.
      token_epoch: ADA.tokenEpoch,
    });
  });

  it("carries an audience array holding loreserver's audience and Team's own origin", async () => {
    const keys = await store();
    const config = identityConfig({ audience: "loreserver", authOrigin: "team.example.com" });

    const { claims } = decodeToken(mintToken(ADA, keys.signingKey, config).token);
    const audience = (claims as { aud: unknown }).aud;

    // An array, not a string: loreserver wants its own audience in there, and
    // the client refuses to send a token that does not name the endpoint it is
    // talking to.
    expect(Array.isArray(audience)).toBe(true);
    expect(audience).toContain("loreserver");
    expect(audience).toContain("https://team.example.com");
  });

  it("says the account is a service account when it is one, and empty groups stay empty", async () => {
    const keys = await store();
    const robot: UserRecord = { ...ADA, isServiceAccount: true, groups: [] };

    const { claims } = decodeToken(mintToken(robot, keys.signingKey, identityConfig()).token);

    expect(claims).toMatchObject({ is_service_account: true, groups: [] });
  });

  it("carries the fingerprint of a real authority, in the spelling trust prints", async () => {
    const root = await temporaryRoot();
    await ensureCertificates(root);
    const authority = await readAuthority(root);
    const keys = await store();

    const { claims } = decodeToken(
      mintToken(ADA, keys.signingKey, identityConfig(), {
        authorityFingerprint: authority.fingerprint256,
      }).token,
    );

    // Studio compares this against a fingerprint it computes from the
    // certificate the endpoint presented, and a person may compare it against
    // what `nlteam trust` printed. Both comparisons are of strings, so the
    // spelling is part of the contract: colon-separated upper-case hex.
    expect((claims as { authority_sha256?: string }).authority_sha256).toBe(
      authority.fingerprint256,
    );
    expect(authority.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  });

  it("leaves the fingerprint out of a token minted for Team's own use", async () => {
    const keys = await store();

    const { claims } = decodeToken(
      mintToken(ADA, keys.signingKey, identityConfig(), { purpose: "repository" }).token,
    );

    // Absent rather than empty. The claim exists for one reader on another
    // machine; a token that never leaves this process has no such reader, and
    // an empty string would look to Studio like an authority it should match.
    expect(claims).not.toHaveProperty("authority_sha256");
  });

  it("expires a lifetime after it was issued, and says which epoch it was minted under", async () => {
    const keys = await store();
    const config = identityConfig({ signInTokenLifetimeSeconds: 60 });

    const minted = mintToken(ADA, keys.signingKey, config);

    expect(minted.claims.exp - minted.claims.iat).toBe(60);
    expect(minted.tokenEpoch).toBe(ADA.tokenEpoch);
  });

  it("takes the repository lifetime when the token is for a data connection", async () => {
    const keys = await store();
    const config = identityConfig({
      signInTokenLifetimeSeconds: 30 * 24 * 60 * 60,
      repositoryTokenLifetimeSeconds: 15 * 60,
    });

    const signIn = mintToken(ADA, keys.signingKey, config);
    const repository = mintToken(ADA, keys.signingKey, config, { purpose: "repository" });

    // Two numbers, not one applied twice. The short one is the only bound on a
    // token loreserver's data plane checks for itself.
    expect(signIn.claims.exp - signIn.claims.iat).toBe(30 * 24 * 60 * 60);
    expect(repository.claims.exp - repository.claims.iat).toBe(15 * 60);
  });

  it("defaults to the sign-in lifetime when a caller names no purpose", async () => {
    const keys = await store();
    const config = identityConfig({
      signInTokenLifetimeSeconds: 3600,
      repositoryTokenLifetimeSeconds: 60,
    });

    const minted = mintToken(ADA, keys.signingKey, config);

    expect(minted.claims.exp - minted.claims.iat).toBe(3600);
  });

  it("refuses to sign anything for a disabled account", async () => {
    const keys = await store();

    expect(() =>
      mintToken({ ...ADA, disabledAt: Date.now() }, keys.signingKey, identityConfig()),
    ).toThrow(DisabledAccountError);
  });

  it("verifies against the published keys, which is all a verifier ever has", async () => {
    const keys = await store();

    const minted = mintToken(ADA, keys.signingKey, identityConfig());

    expect(verifyAgainstJwks(minted.token, keys.jwks())).toBe(true);
  });

  it("refuses a token whose claims were changed after it was signed", async () => {
    const keys = await store();
    const minted = mintToken(ADA, keys.signingKey, identityConfig());
    const [header, claims, signature] = minted.token.split(".");
    const tampered = Buffer.from(
      JSON.stringify({ ...(decodeToken(minted.token).claims as object), sub: "somebody-else" }),
      "utf8",
    ).toString("base64url");

    expect(verifyAgainstJwks(`${header}.${tampered}.${signature}`, keys.jwks())).toBe(false);
    expect(claims).not.toBe(tampered);
  });

  it("keeps verifying tokens from both keys after a rotation", async () => {
    const keys = await store();
    const before = mintToken(ADA, keys.signingKey, identityConfig());

    await keys.rotate();
    const after = mintToken(ADA, keys.signingKey, identityConfig());
    const jwks = keys.jwks();

    expect(jwks.keys).toHaveLength(2);
    expect(before.header.kid).not.toBe(after.header.kid);
    expect(verifyAgainstJwks(before.token, jwks)).toBe(true);
    expect(verifyAgainstJwks(after.token, jwks)).toBe(true);
  });

  it("stops verifying a retired key's tokens, which is why retiring is separate", async () => {
    const keys = await store();
    const before = mintToken(ADA, keys.signingKey, identityConfig());
    const retired = keys.signingKey.kid;
    await keys.rotate();

    await keys.retire(retired);

    expect(verifyAgainstJwks(before.token, keys.jwks())).toBe(false);
  });
  it("carries the account's address when it has one, and nothing when it does not", async () => {
    // A client that takes its authorship from this token can write only what
    // the token carries, and a revision's author is a name and an address
    // everywhere else.
    const keys = await store();
    const config = identityConfig({ authOrigin: "team.example.com" });

    const withAddress = mintToken({ ...ADA, email: "ada@example.com" }, keys.signingKey, config);
    expect(withAddress.claims.email).toBe("ada@example.com");

    const without = mintToken({ ...ADA, email: undefined }, keys.signingKey, config);
    expect(without.claims.email).toBeUndefined();
    expect(Object.keys(without.claims)).not.toContain("email");
  });

});
