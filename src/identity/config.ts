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
   * without a scheme, for example `hub.example.com:41402`.
   *
   * Studio refuses to use a token whose `aud` does not name the endpoint it is
   * talking to, so this value reaches the token as well as the configuration.
   * It is also the name the endpoint's certificate has to carry, which is why
   * `up --hostname` exists: a certificate for `127.0.0.1` proves nothing about
   * a machine somebody reaches as `hub.example.com`.
   *
   * When an operator names none, it is this machine's loopback at the TLS
   * port, so the default configuration is consistent with itself.
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
  /**
   * The port Hub's authorization service listens on in plain HTTP/2.
   *
   * This is where loreserver, on the same machine, asks whether a caller may
   * touch a repository. It is a second port rather than a second path on
   * {@link hubPort} because the two speak different protocols: one serves
   * documents over HTTP/1.1, the other gRPC over HTTP/2.
   */
  readonly authPort: number;
  /**
   * The port the same service listens on over TLS.
   *
   * A Studio installation signs in here and will not use anything else: its
   * client library accepts only `https` and `ucs-auth`, and refuses `http` and
   * `grpc` by name. The two listeners serve identical methods; what differs is
   * that one is reachable from another machine and one is not.
   */
  readonly authTlsPort: number;
}

/** The identity settings used when an operator names none. */
export const DEFAULT_IDENTITY: IdentityConfig = {
  issuer: "narraleaf-hub",
  audience: "loreserver",
  // The TLS listener on this machine, so the default configuration is
  // consistent with itself. A deployment other people reach names its own host
  // with --auth-origin, and its certificate is given that name with --hostname.
  authOrigin: "127.0.0.1:41402",
  env: "local",
  idp: "narraleaf-hub",
  tokenLifetimeSeconds: 15 * 60,
  hubPort: 41400,
  authPort: 41401,
  authTlsPort: 41402,
};

/**
 * The identity settings, with anything an operator named replacing a default.
 *
 * Every command that mints a token or writes loreserver's configuration builds
 * its settings this way, so that the same options given to two commands mean
 * the same thing to both.
 *
 * The auth origin follows the TLS port when it is not named outright. Without
 * that, moving the listener with `--auth-tls-port` would leave every token
 * claiming an audience nothing listens on, and a client would refuse the token
 * it had just been given.
 */
export function identityConfig(overrides: Partial<IdentityConfig> = {}): IdentityConfig {
  const merged = { ...DEFAULT_IDENTITY, ...overrides };
  return overrides.authOrigin === undefined
    ? { ...merged, authOrigin: `127.0.0.1:${merged.authTlsPort}` }
    : merged;
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
 * Every entry has to be there. loreserver refuses a token whose audience does
 * not include the one it was configured with, and a Studio installation refuses
 * to use a token whose audience does not name the auth endpoint it is talking
 * to — "JWT 'aud' does not specify remote domain", which it treats as a token
 * that might leak somewhere it does not belong.
 *
 * The origin is written both with and without a trailing slash because the two
 * sides of that comparison are not known to be normalised the same way: the
 * client's own message about it has been seen carrying the slash. An audience
 * a verifier ignores costs a few bytes; one a client will not match costs the
 * sign-in.
 *
 * Duplicates are dropped, because a repeated audience says nothing extra.
 */
export function tokenAudience(config: IdentityConfig): string[] {
  const auth = authUrl(config);
  return [...new Set([config.audience, auth, `${auth}/`])];
}

/** Where Hub publishes its JWKS, as loreserver is told to fetch it. */
export function jwksUrl(hubPort: number, host = "127.0.0.1"): string {
  return `http://${host}:${hubPort}/.well-known/jwks.json`;
}

/**
 * The plaintext address of the same authorization service, on the loopback.
 *
 * This is not what goes into loreserver's `auth_url`: that key is also how a
 * client is told where to sign in, so it has to be the https origin. This
 * address is the one loreserver can be pointed at when it cannot verify Hub's
 * certificate itself, and it is what `nlhub project create` and the tests use,
 * because neither of them is a client that needs telling anything.
 */
export function plaintextAuthUrl(config: IdentityConfig, host = "127.0.0.1"): string {
  return `http://${host}:${config.authPort}`;
}
