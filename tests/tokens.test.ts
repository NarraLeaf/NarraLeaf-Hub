import { createPublicKey, createVerify } from "node:crypto";

import { describe, expect, it } from "vitest";

import { identityConfig } from "../src/identity/config.js";
import { KeyStore, type JwksDocument } from "../src/identity/keys.js";
import { identityLayout } from "../src/identity/layout.js";
import { decodeToken, DisabledAccountError, mintToken } from "../src/identity/tokens.js";
import type { UserRecord } from "../src/identity/users.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlhub-tokens-");

const ADA: UserRecord = {
  id: "9a1c0e2e-3b7d-4d2a-8f0e-5b6d7c8e9f00",
  username: "ada",
  displayName: "Ada Lovelace",
  email: "ada@example.com",
  isServiceAccount: false,
  createdAt: 1_700_000_000_000,
  disabledAt: undefined,
  tokenEpoch: 3,
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
      issuer: "narraleaf-hub",
      audience: "loreserver",
      authOrigin: "hub.example.com",
    });
    const now = new Date("2026-08-11T09:00:00.000Z");

    const minted = mintToken(ADA, keys.signingKey, config, { now });
    const { header, claims } = decodeToken(minted.token);

    expect(header).toEqual({ alg: "RS256", typ: "JWT", kid: keys.signingKey.kid });
    expect(claims).toEqual({
      iss: "narraleaf-hub",
      aud: ["loreserver", "https://hub.example.com", "https://hub.example.com/"],
      sub: ADA.id,
      env: "local",
      name: "Ada Lovelace",
      preferred_username: "ada",
      groups: ["admin", "authors"],
      is_service_account: false,
      idp: "narraleaf-hub",
      iat: 1_786_438_800,
      exp: 1_786_438_800 + 15 * 60,
      // Hub's own claim, and the only one loreserver does not read: it is what
      // lets Hub refuse a token that was signed before this account's access
      // was revoked.
      token_epoch: ADA.tokenEpoch,
    });
  });

  it("carries an audience array holding loreserver's audience and Hub's own origin", async () => {
    const keys = await store();
    const config = identityConfig({ audience: "loreserver", authOrigin: "hub.example.com" });

    const { claims } = decodeToken(mintToken(ADA, keys.signingKey, config).token);
    const audience = (claims as { aud: unknown }).aud;

    // An array, not a string: loreserver wants its own audience in there, and
    // the client refuses to send a token that does not name the endpoint it is
    // talking to.
    expect(Array.isArray(audience)).toBe(true);
    expect(audience).toContain("loreserver");
    expect(audience).toContain("https://hub.example.com");
  });

  it("says the account is a service account when it is one, and empty groups stay empty", async () => {
    const keys = await store();
    const robot: UserRecord = { ...ADA, isServiceAccount: true, groups: [] };

    const { claims } = decodeToken(mintToken(robot, keys.signingKey, identityConfig()).token);

    expect(claims).toMatchObject({ is_service_account: true, groups: [] });
  });

  it("expires a lifetime after it was issued, and says which epoch it was minted under", async () => {
    const keys = await store();
    const config = identityConfig({ tokenLifetimeSeconds: 60 });

    const minted = mintToken(ADA, keys.signingKey, config);

    expect(minted.claims.exp - minted.claims.iat).toBe(60);
    expect(minted.tokenEpoch).toBe(ADA.tokenEpoch);
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
});
