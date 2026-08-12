import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { GrpcCallError, unaryCall } from "../src/grpc/client.js";
import {
  decodeExchangeExternalTokenForUserTokenResponse,
  encodeExchangeExternalTokenForUserTokenRequest,
  METHOD_EXCHANGE_EXTERNAL_TOKEN,
  type UserToken,
} from "../src/grpc/messages.js";
import type { GrpcServer } from "../src/grpc/server.js";
import { GRPC_UNAUTHENTICATED } from "../src/grpc/status.js";
import { authUrl, identityConfig } from "../src/identity/config.js";
import { openMigratedDatabase } from "../src/identity/database.js";
import { KeyStore } from "../src/identity/keys.js";
import { identityLayout } from "../src/identity/layout.js";
import { ScryptPasswordHasher, type ScryptParameters } from "../src/identity/passwords.js";
import { mintToken, verifyToken } from "../src/identity/tokens.js";
import {
  createUser,
  disableUser,
  enableUser,
  requireUser,
  type UserRecord,
} from "../src/identity/users.js";
import { startAuthorizationService } from "../src/projects/service.js";
import { ensureCertificates } from "../src/tls/authority.js";
import { useTemporaryRoots } from "./temporary.js";

const temporaryRoot = useTemporaryRoots("nlhub-exchange-");

const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };
const hasher = new ScryptPasswordHasher(CHEAP);

/** A running service and the pieces a test needs to talk to it. */
interface Harness {
  readonly database: DatabaseSync;
  readonly server: GrpcServer;
  readonly keys: KeyStore;
  readonly log: string[];
  /** The certificate authority, when this harness is serving TLS. */
  readonly caPem: string | undefined;
  user(username: string): Promise<UserRecord>;
  /** A token for `user`, as its own client library would present it. */
  tokenFor(user: UserRecord, options?: { readonly now?: Date }): string;
  exchange(externalToken: string): Promise<UserToken | undefined>;
}

const started: Harness[] = [];

afterEach(async () => {
  while (started.length > 0) {
    const harness = started.pop();
    if (harness === undefined) {
      continue;
    }
    await harness.server.close();
    harness.database.close();
  }
});

/**
 * A service on a free port, in plaintext or over TLS.
 *
 * The TLS form is driven through the same client with the Hub's own authority
 * as its `ca`, which is what a Studio installation does once a person has run
 * `nlhub trust --install` — with the difference that this test hands the
 * certificate over rather than asking the operating system for it.
 */
async function harness(options: { readonly tls?: boolean } = {}): Promise<Harness> {
  const root = await temporaryRoot();
  const layout = identityLayout(root);
  const database = await openMigratedDatabase(layout.databasePath);
  const keys = await KeyStore.open(layout.keysDir);
  const log: string[] = [];
  const certificates = options.tls === true ? await ensureCertificates(root) : undefined;
  const config = identityConfig();

  const server = await startAuthorizationService({
    // Port 0: the operating system picks one that is free, so a test run cannot
    // collide with a Hub the machine is already running.
    port: 0,
    database,
    keys,
    config,
    log: (line) => log.push(line),
    ...(certificates === undefined
      ? {}
      : { tls: { cert: certificates.leafCertPem, key: certificates.leafKeyPem } }),
  });

  const instance: Harness = {
    database,
    server,
    keys,
    log,
    caPem: certificates?.authority.pem,
    async user(username: string): Promise<UserRecord> {
      await createUser(database, hasher, { username, password: "a password nobody guesses" });
      return requireUser(database, username);
    },
    tokenFor(user: UserRecord, mintOptions = {}): string {
      return mintToken(user, keys.signingKey, config, mintOptions).token;
    },
    async exchange(externalToken: string): Promise<UserToken | undefined> {
      const reply = await unaryCall({
        url: server.url,
        path: METHOD_EXCHANGE_EXTERNAL_TOKEN,
        message: encodeExchangeExternalTokenForUserTokenRequest({
          externalToken,
          // Passed through by the client and read by nobody: Hub knows one kind
          // of token.
          tokenType: "jwt",
        }),
        ...(certificates === undefined ? {} : { ca: certificates.authority.pem }),
        timeoutMs: 5000,
      });
      return decodeExchangeExternalTokenForUserTokenResponse(reply).userToken;
    },
  };

  started.push(instance);
  return instance;
}

describe("ExchangeExternalTokenForUserToken", () => {
  it("hands back a token issued now, not the one it was given", async () => {
    const hub = await harness();
    const ada = await hub.user("ada");
    const config = identityConfig();
    // Minted five minutes ago, so the one that comes back can be told apart
    // from it by when it expires. A token minted twice in the same second is
    // byte-identical — the claims are the same and RS256 is deterministic — so
    // comparing the strings would prove nothing either way.
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const presented = hub.tokenFor(ada, { now: fiveMinutesAgo });

    const issued = await hub.exchange(presented);
    const verified = verifyToken(issued?.userToken ?? "", hub.keys, config);
    const before = verifyToken(presented, hub.keys, config);

    // Issued now, which is what makes an exchange a check rather than a
    // renewal: the new token carries the account's state as it stands now.
    expect(verified.kind).toBe("verified");
    expect(verified.kind === "verified" && verified.claims.iat).toBeGreaterThan(
      before.kind === "verified" ? before.claims.iat : 0,
    );
    expect(issued?.expiresAt).toBe(verified.kind === "verified" ? verified.claims.exp : 0);
  });

  it("puts the origin of the auth endpoint in the token's audience", async () => {
    const hub = await harness();
    const ada = await hub.user("ada");
    const config = identityConfig();

    const issued = await hub.exchange(hub.tokenFor(ada));
    const verified = verifyToken(issued?.userToken ?? "", hub.keys, config);

    // A client refuses a token whose `aud` does not name the endpoint it is
    // talking to, calling it a leak risk. Both spellings of the origin are
    // there, because the two sides of that comparison are not known to
    // normalise a trailing slash the same way.
    expect(verified.kind === "verified" && verified.claims.aud).toContain(authUrl(config));
    expect(verified.kind === "verified" && verified.claims.aud).toContain(`${authUrl(config)}/`);
    expect(verified.kind === "verified" && verified.claims.aud).toContain(config.audience);
  });

  it("names the account in the fields a client keys its state by", async () => {
    const hub = await harness();
    await createUser(hub.database, hasher, {
      username: "ada",
      password: "a password nobody guesses",
      displayName: "Ada Lovelace",
    });
    const ada = requireUser(hub.database, "ada");

    const issued = await hub.exchange(hub.tokenFor(ada));

    expect(issued?.userId).toBe(ada.id);
    expect(issued?.userName).toBe("Ada Lovelace");
    // Seconds since the epoch, as an int64 — not milliseconds, and not text.
    expect(issued?.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(issued?.expiresAt).toBeLessThan(Math.floor(Date.now() / 1000) + 3600);
  });

  it("refuses a token for an account that has been disabled", async () => {
    const hub = await harness();
    const ada = await hub.user("ada");
    const presented = hub.tokenFor(ada);
    disableUser(hub.database, ada.username);

    // A status, not an empty success: an absent token on an OK reply looks to a
    // client like a server fault rather than a refusal.
    await expect(hub.exchange(presented)).rejects.toThrow(GrpcCallError);
    await expect(hub.exchange(presented)).rejects.toMatchObject({
      status: GRPC_UNAUTHENTICATED,
    });
    expect(hub.log.some((line) => line.includes("the account is disabled"))).toBe(true);
  });

  it("refuses a token that has expired", async () => {
    const hub = await harness();
    const ada = await hub.user("ada");
    const lastYear = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const presented = hub.tokenFor(ada, { now: lastYear });

    await expect(hub.exchange(presented)).rejects.toMatchObject({
      status: GRPC_UNAUTHENTICATED,
    });
    expect(hub.log.some((line) => line.includes("the token has expired"))).toBe(true);
  });

  it("refuses a token signed by a key this Hub does not publish", async () => {
    const hub = await harness();
    const stranger = await harness();
    const ada = await hub.user("ada");
    await stranger.user("ada");

    // The same claims, signed by another Hub's key. Nothing but the signature
    // distinguishes it, which is the point.
    const presented = mintToken(ada, stranger.keys.signingKey, identityConfig()).token;

    await expect(hub.exchange(presented)).rejects.toMatchObject({
      status: GRPC_UNAUTHENTICATED,
    });
    expect(hub.log.some((line) => line.includes("no published key"))).toBe(true);
  });

  it("refuses a token issued before the account's access was revoked", async () => {
    const hub = await harness();
    const ada = await hub.user("ada");
    const presented = hub.tokenFor(ada);
    // Disabling bumps the epoch as well as setting disabled_at, so the account
    // is enabled again to leave the epoch as the only thing refusing this.
    disableUser(hub.database, ada.username);
    enableUser(hub.database, ada.username);

    await expect(hub.exchange(presented)).rejects.toMatchObject({
      status: GRPC_UNAUTHENTICATED,
    });
    expect(hub.log.some((line) => line.includes("before the account's access was revoked"))).toBe(
      true,
    );
  });

  it("refuses a request carrying no token at all", async () => {
    const hub = await harness();

    await expect(hub.exchange("")).rejects.toMatchObject({ status: GRPC_UNAUTHENTICATED });
  });

  it("says nothing about which check failed", async () => {
    const hub = await harness();
    const ada = await hub.user("ada");
    disableUser(hub.database, ada.username);

    const failure = await hub.exchange(hub.tokenFor(ada)).catch((error: unknown) => error);

    // The distinctions are in Hub's log and nowhere else: this is the one
    // method reachable by anybody who can open a socket to the endpoint.
    expect(failure).toBeInstanceOf(GrpcCallError);
    expect((failure as GrpcCallError).statusMessage).toBe(
      "the token presented for exchange was not accepted",
    );
  });
});

describe("the same service over TLS", () => {
  it("completes a handshake and answers an exchange", async () => {
    const hub = await harness({ tls: true });
    const ada = await hub.user("ada");

    expect(hub.server.url.startsWith("https://")).toBe(true);
    const issued = await hub.exchange(hub.tokenFor(ada));

    expect(issued?.userId).toBe(ada.id);
    expect(verifyToken(issued?.userToken ?? "", hub.keys, identityConfig()).kind).toBe("verified");
  });

  it("cannot be reached by a client that does not have the authority", async () => {
    const hub = await harness({ tls: true });
    const ada = await hub.user("ada");

    // No `ca`, so node falls back to the host's own trust store — which is
    // exactly the state a Studio installation is in before `nlhub trust`.
    await expect(
      unaryCall({
        url: hub.server.url,
        path: METHOD_EXCHANGE_EXTERNAL_TOKEN,
        message: encodeExchangeExternalTokenForUserTokenRequest({
          externalToken: hub.tokenFor(ada),
          tokenType: "jwt",
        }),
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/self-signed|unable to (verify|get)/i);
  });
});
