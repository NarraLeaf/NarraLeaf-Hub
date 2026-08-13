import { createPublicKey, createVerify } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { identityConfig, jwksUrl } from "../src/identity/config.js";
import { IdentityEndpoint } from "../src/identity/endpoint.js";
import { KeyStore, type JwksDocument } from "../src/identity/keys.js";
import { identityLayout } from "../src/identity/layout.js";
import { mintToken } from "../src/identity/tokens.js";
import type { UserRecord } from "../src/identity/users.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlteam-endpoint-");

const ADA: UserRecord = {
  id: "0d7a1f1c-2b3c-4d5e-8f90-a1b2c3d4e5f6",
  username: "ada",
  displayName: "Ada Lovelace",
  email: undefined,
  isServiceAccount: false,
  createdAt: 1_700_000_000_000,
  disabledAt: undefined,
  tokenEpoch: 1,
  tokensInvalidatedAt: undefined,
  groups: [],
};

const running: IdentityEndpoint[] = [];

afterEach(async () => {
  while (running.length > 0) {
    await running.pop()?.close();
  }
});

/** An endpoint on a port the operating system picks, and the keys behind it. */
async function serve(): Promise<{ endpoint: IdentityEndpoint; keys: KeyStore }> {
  const keys = await KeyStore.open(identityLayout(await temporaryRoot()).keysDir);
  const endpoint = await IdentityEndpoint.start({
    port: 0,
    jwks: () => keys.jwks(),
    version: "0.1.0-test",
  });
  running.push(endpoint);
  return { endpoint, keys };
}

describe("IdentityEndpoint", () => {
  it("answers /health with the version of the Team server that is answering", async () => {
    const { endpoint } = await serve();

    const response = await fetch(`${endpoint.url}/health`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ ok: true, version: "0.1.0-test" });
  });

  it("serves the JWKS where loreserver is told to look for it", async () => {
    const { endpoint, keys } = await serve();

    const response = await fetch(`${endpoint.url}/.well-known/jwks.json`);
    const document = (await response.json()) as JwksDocument;

    expect(response.status).toBe(200);
    expect(document.keys).toHaveLength(1);
    expect(document.keys[0]).toMatchObject({
      kty: "RSA",
      kid: keys.signingKey.kid,
      alg: "RS256",
      use: "sig",
    });
    // The path is the one written into loreserver's configuration; the two
    // being the same string is what makes the fetch work at all.
    expect(new URL(jwksUrl(1)).pathname).toBe("/.well-known/jwks.json");
  });

  it("serves both keys after a rotation, without being restarted", async () => {
    const { endpoint, keys } = await serve();
    const first = keys.signingKey.kid;

    const second = await keys.rotate();
    const document = (await (await fetch(`${endpoint.url}/.well-known/jwks.json`)).json()) as
      JwksDocument;

    expect(document.keys.map((key) => key.kid)).toEqual([second.kid, first]);
  });

  it("hands a verifier enough to check a token, and nothing more", async () => {
    const { endpoint, keys } = await serve();
    const before = mintToken(ADA, keys.signingKey, identityConfig());
    await keys.rotate();
    const after = mintToken(ADA, keys.signingKey, identityConfig());

    const document = (await (await fetch(`${endpoint.url}/.well-known/jwks.json`)).json()) as
      JwksDocument;

    // This is loreserver's path exactly: fetch the document over plain HTTP,
    // pick the key the header names, check the signature with it.
    for (const minted of [before, after]) {
      const published = document.keys.find((key) => key.kid === minted.header.kid);
      expect(published).toBeDefined();
      const [header, claims, signature] = minted.token.split(".");
      const verified = createVerify("RSA-SHA256")
        .update(`${header}.${claims}`)
        .verify(
          createPublicKey({
            key: { kty: "RSA", n: published?.n ?? "", e: published?.e ?? "" },
            format: "jwk",
          }),
          Buffer.from(signature ?? "", "base64url"),
        );
      expect(verified).toBe(true);
    }
    // No private material is served: the document is exactly the public halves.
    expect(JSON.stringify(document)).not.toContain('"d"');
  });

  it("serves nothing else, and invites no browser to ask", async () => {
    const { endpoint } = await serve();

    const missing = await fetch(`${endpoint.url}/users`);
    const written = await fetch(`${endpoint.url}/health`, { method: "POST" });

    expect(missing.status).toBe(404);
    expect(written.status).toBe(405);
    // No CORS: nothing in a browser has any business calling this.
    expect(missing.headers.get("access-control-allow-origin")).toBeNull();
    await missing.body?.cancel();
    await written.body?.cancel();
  });

  it("ignores a query string rather than letting it choose a route", async () => {
    const { endpoint } = await serve();

    const response = await fetch(`${endpoint.url}/health?pretty=1`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });
});
