/**
 * The settings that decide what a Hub token says and who will accept it.
 *
 * Three of them — the issuer, the audience and Hub's own auth origin — are
 * written into two files at once: they appear in every token Hub mints, and in
 * the `local.toml` Hub generates for loreserver. A token is accepted only when
 * both copies agree, so they are read from one place rather than typed twice.
 */

/** Where the identity settings come from when an operator names none. */
export interface IdentityConfig {
  /** The `iss` claim, and loreserver's `jwt_issuer`. Any stable string. */
  readonly issuer: string;
  /**
   * The audience loreserver is configured to require. It is one entry of the
   * `aud` array, not the whole of it — see {@link tokenAudience}.
   */
  readonly audience: string;
  /**
   * Host and optional port of the endpoint Studio authenticates against,
   * without a scheme, for example `hub.example.com`.
   *
   * Studio refuses to send a token whose `aud` does not name the endpoint it
   * is talking to, so this value has to reach the token as well as the
   * configuration. The auth endpoint itself is not part of this build; what
   * the value does today is put the right origin in `aud` and in loreserver's
   * `auth_url`, so that a client pointed at a real deployment is not refused
   * by either side.
   */
  readonly authOrigin: string;
  /** The `env` claim. `local` is the only value that has been tested. */
  readonly env: string;
  /** The `idp` claim: which identity provider vouched for the user. */
  readonly idp: string;
  /**
   * How long a minted token is good for.
   *
   * This is also the revocation window; src/identity/tokens.ts says why, and
   * why the number is minutes rather than hours.
   */
  readonly tokenLifetimeSeconds: number;
  /** The port Hub's own HTTP endpoint listens on. */
  readonly hubPort: number;
}

/** The identity settings used when an operator names none. */
export const DEFAULT_IDENTITY: IdentityConfig = {
  issuer: "narraleaf-hub",
  audience: "loreserver",
  // The endpoint Hub serves is on this port of this machine, so the default
  // configuration is consistent with itself on one machine. A deployment other
  // people reach names its own host with --auth-origin.
  authOrigin: "127.0.0.1:41400",
  env: "local",
  idp: "narraleaf-hub",
  tokenLifetimeSeconds: 15 * 60,
  hubPort: 41400,
};

/**
 * The identity settings, with anything an operator named replacing a default.
 *
 * Every command that mints a token or writes loreserver's configuration builds
 * its settings this way, so that the same options given to two commands mean
 * the same thing to both.
 */
export function identityConfig(overrides: Partial<IdentityConfig> = {}): IdentityConfig {
  return { ...DEFAULT_IDENTITY, ...overrides };
}

/**
 * The URL form of Hub's auth origin.
 *
 * The scheme is fixed at `https`: the origin names an endpoint people
 * authenticate against from other machines, and a password may not travel in
 * clear. Hub's own JWKS endpoint is a different thing and is plain HTTP —
 * public keys are not a secret, and loreserver fetches them over the loopback.
 */
export function authUrl(config: IdentityConfig): string {
  return `https://${config.authOrigin}`;
}

/**
 * The `aud` array a minted token carries.
 *
 * Both entries have to be there. loreserver refuses a token whose audience
 * does not include the one it was configured with, and Studio refuses to send
 * a token whose audience does not include the auth endpoint it is talking to.
 * The two are collapsed into one entry when they are the same string, because
 * a repeated audience says nothing extra.
 */
export function tokenAudience(config: IdentityConfig): string[] {
  const auth = authUrl(config);
  return config.audience === auth ? [config.audience] : [config.audience, auth];
}

/** Where Hub publishes its JWKS, as loreserver is told to fetch it. */
export function jwksUrl(hubPort: number, host = "127.0.0.1"): string {
  return `http://${host}:${hubPort}/.well-known/jwks.json`;
}
