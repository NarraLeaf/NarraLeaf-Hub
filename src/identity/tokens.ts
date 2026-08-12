/**
 * Minting the tokens a Studio installation presents to loreserver.
 *
 * The claim set is not a suggestion. loreserver 0.8.6 refuses a token that is
 * missing any of these and names the field it wanted, so every one of them is
 * written on every token:
 *
 *     iss                 matches loreserver's configured jwt_issuer
 *     aud                 an array, holding loreserver's audience and the
 *                         origin of Hub's auth endpoint
 *     sub                 the user id
 *     env                 environment name
 *     name                display name
 *     preferred_username
 *     groups              array, possibly empty
 *     is_service_account  boolean
 *     idp                 which identity provider vouched for the user
 *     iat, exp
 *
 * Nothing else is added. An extra claim is not refused, but it would be
 * something no verifier reads and every token carries.
 */
import { createSign } from "node:crypto";

import { tokenAudience, type IdentityConfig } from "./config.js";
import type { HubKey } from "./keys.js";
import type { UserRecord } from "./users.js";

/** The claims of one token, in the shape they are signed in. */
export interface TokenClaims {
  readonly iss: string;
  readonly aud: readonly string[];
  readonly sub: string;
  readonly env: string;
  readonly name: string;
  readonly preferred_username: string;
  readonly groups: readonly string[];
  readonly is_service_account: boolean;
  readonly idp: string;
  /** Seconds since the epoch, as JWT counts time. */
  readonly iat: number;
  readonly exp: number;
}

/** The JOSE header of one token. */
export interface TokenHeader {
  readonly alg: "RS256";
  readonly typ: "JWT";
  /** Which published key verifies this token. */
  readonly kid: string;
}

/** A minted token and everything about it a caller might record. */
export interface MintedToken {
  /** The compact JWT: header, claims and signature, dot-separated. */
  readonly token: string;
  readonly header: TokenHeader;
  readonly claims: TokenClaims;
  /**
   * The `token_epoch` the user was at when this was minted.
   *
   * Recorded so that whatever exchanges a token later can compare it with the
   * user's epoch as it stands then, and refuse to renew one issued before a
   * revocation.
   */
  readonly tokenEpoch: number;
}

/** Raised when a token was asked for on behalf of an account that is disabled. */
export class DisabledAccountError extends Error {
  constructor(readonly username: string) {
    super(`${username} is disabled, so no token can be issued for them.`);
    this.name = "DisabledAccountError";
  }
}

/** Base64url of a JSON value, which is how JOSE writes both of a token's parts. */
function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** Options a caller may vary per token. */
export interface MintOptions {
  /** When the token is issued. Supplied by tests; defaults to the clock. */
  readonly now?: Date;
}

/**
 * Sign a token for `user`.
 *
 * What revoking access does, and what it does not
 * ----------------------------------------------
 * loreserver checks a token's signature and its expiry. It asks Hub nothing
 * else: there is no introspection call, no revocation list, and no callback.
 * Hub therefore cannot withdraw a token it has already handed out.
 *
 * What that means in practice:
 *
 *   - Disabling an account takes effect at once for anything that mints or
 *     exchanges a token. This function refuses outright, and so does the sign-in
 *     path; the account cannot obtain anything new from the moment it is
 *     disabled.
 *   - A token already in someone's hands keeps working until `exp`. Nothing in
 *     this system can stop that, short of rotating and retiring the signing key,
 *     which invalidates everybody's tokens at once.
 *   - Bumping the user's `token_epoch` is what makes their outstanding tokens
 *     unrenewable: the epoch is recorded when a token is minted, and an exchange
 *     compares it with the user's epoch as it stands then.
 *
 * So the lifetime is the revocation window. That is why it is fifteen minutes
 * and not a day: the number is how long a disabled account keeps working, and
 * every extra hour of convenience is an extra hour of exactly that.
 */
export function mintToken(
  user: UserRecord,
  key: HubKey,
  config: IdentityConfig,
  options: MintOptions = {},
): MintedToken {
  if (user.disabledAt !== undefined) {
    throw new DisabledAccountError(user.username);
  }

  const issuedAt = Math.floor((options.now?.getTime() ?? Date.now()) / 1000);
  const header: TokenHeader = { alg: "RS256", typ: "JWT", kid: key.kid };
  const claims: TokenClaims = {
    iss: config.issuer,
    // Assembled from the configuration, never a literal: one of the two
    // entries is the origin of Hub's own auth endpoint, which is a fact about
    // where this Hub is deployed.
    aud: tokenAudience(config),
    sub: user.id,
    env: config.env,
    name: user.displayName,
    preferred_username: user.username,
    groups: user.groups,
    is_service_account: user.isServiceAccount,
    idp: config.idp,
    iat: issuedAt,
    exp: issuedAt + config.tokenLifetimeSeconds,
  };

  const signingInput = `${encodeSegment(header)}.${encodeSegment(claims)}`;
  // RSASSA-PKCS1-v1_5 with SHA-256 — the "RS256" the header names, and what
  // loreserver has been shown to verify. Naming the digest and the key is the
  // whole of the choice; node reads the padding from the key type.
  const signature = createSign("RSA-SHA256").update(signingInput).sign(key.privateKey);

  return {
    token: `${signingInput}.${signature.toString("base64url")}`,
    header,
    claims,
    tokenEpoch: user.tokenEpoch,
  };
}

/** The header and claims of a compact JWT, without checking its signature. */
export function decodeToken(token: string): { header: unknown; claims: unknown } {
  const [header, claims] = token.split(".");
  if (header === undefined || claims === undefined) {
    throw new Error("this is not a compact JWT: it has fewer than three parts");
  }
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as unknown,
    claims: JSON.parse(Buffer.from(claims, "base64url").toString("utf8")) as unknown,
  };
}
