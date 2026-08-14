/**
 * Who has a browser open on this server, for as long as they do.
 *
 * A session is not a token. Nothing here is signed, nothing here leaves this
 * process, and nothing here is accepted anywhere else: what the browser holds
 * is 32 random bytes that mean something to this one running Team server and
 * to nobody else. That is deliberate. The obvious alternative — putting a
 * minted sign-in token in the cookie — would make a stolen cookie a working
 * credential at the data endpoint as well, and a browser is the one place a
 * credential is hardest to keep.
 *
 * What is stored is the hash of those bytes rather than the bytes. A session
 * table that leaked, in a heap dump or a debugger, would then be a list of
 * hashes and not a drawer of live keys.
 *
 * **Sessions live in memory, so restarting Team signs everybody out.** That is
 * the honest behaviour rather than a shortcut: the operators of a server are a
 * handful of people, signing in again costs one password, and the alternative
 * is a table in the database whose rows outlive every process that could have
 * explained them.
 *
 * Revocation reaches here, which is the part worth getting right. Every request
 * looks the account up again and compares its `token_epoch` with the one
 * recorded when the session opened, so `nlteam user revoke-tokens` closes the
 * browser session too, and a disabled account stops being able to load a page
 * on its next request rather than when its cookie expires.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { storedTokenLifetimes } from "../identity/settings.js";
import { findUserById, type UserRecord } from "../identity/users.js";

import type { DatabaseSync } from "node:sqlite";

/** The name of the cookie a browser sends back. */
export const SESSION_COOKIE = "nlteam_session";

/** How many bytes of randomness a session identifier carries. */
const SECRET_BYTES = 32;

/** What is kept about one open session. */
interface SessionRecord {
  readonly userId: string;
  /**
   * The account's token epoch when this session opened.
   *
   * A session from a lower epoch was opened before somebody revoked this
   * account's access, which is exactly what src/identity/bearer.ts says about a
   * token from a lower epoch, and it is refused for the same reason.
   */
  readonly epoch: number;
  readonly openedAt: number;
  readonly expiresAt: number;
}

/** Why a request is not somebody. */
export type SessionRefusal =
  /** No cookie arrived, or one that names no session here. */
  | "no-session"
  | "expired"
  | "unknown-account"
  | "disabled"
  | "revoked";

/** One sentence for each way a session can fail to be somebody. */
const REFUSAL_REASONS: Readonly<Record<SessionRefusal, string>> = {
  "no-session": "this browser is not signed in",
  expired: "the session has expired",
  "unknown-account": "the session names an account this server does not have",
  disabled: "the account is disabled",
  revoked: "the session was opened before the account's access was revoked",
};

/** Say why somebody was turned away, for the page that has to say something. */
export function describeSessionRefusal(reason: SessionRefusal): string {
  return REFUSAL_REASONS[reason];
}

/** Who is asking, or why nobody is. */
export type SessionIdentification =
  | { readonly kind: "identified"; readonly user: UserRecord; readonly expiresAt: number }
  | { readonly kind: "refused"; readonly reason: SessionRefusal };

/** The hash a session is filed under. */
function fingerprint(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * The open sessions of one running server.
 *
 * Held by the process that serves the web interface and dropped with it. A
 * clock is passed in so a test can watch a session expire without waiting for
 * one.
 */
export class SessionStore {
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** How many sessions are open, after forgetting the ones that are not. */
  get size(): number {
    this.#sweep();
    return this.#sessions.size;
  }

  /**
   * Open a session for an account that has just proved who it is.
   *
   * The lifetime is the sign-in token's lifetime, read from the database on
   * every sign-in rather than captured once: an operator who shortens it on the
   * settings surface has shortened this too, and one setting that governs how
   * long being signed in lasts is easier to reason about than two.
   */
  open(database: DatabaseSync, user: UserRecord): { secret: string; expiresAt: number } {
    this.#sweep();
    const secret = randomBytes(SECRET_BYTES).toString("base64url");
    const lifetimeMs = storedTokenLifetimes(database).signInTokenLifetimeSeconds * 1000;
    const openedAt = this.#now();
    const expiresAt = openedAt + lifetimeMs;
    this.#sessions.set(fingerprint(secret), {
      userId: user.id,
      epoch: user.tokenEpoch,
      openedAt,
      expiresAt,
    });
    return { secret, expiresAt };
  }

  /**
   * Say who is holding this session, asking the database again.
   *
   * Again, not from what was stored when it opened: an account is disabled and
   * its tokens are revoked while its browser sits on a page, and the page it
   * asks for next is the first moment either can be noticed.
   */
  identify(database: DatabaseSync, secret: string | undefined): SessionIdentification {
    if (secret === undefined || secret === "") {
      return { kind: "refused", reason: "no-session" };
    }
    const key = fingerprint(secret);
    const session = this.#sessions.get(key);
    if (session === undefined) {
      return { kind: "refused", reason: "no-session" };
    }
    if (session.expiresAt <= this.#now()) {
      this.#sessions.delete(key);
      return { kind: "refused", reason: "expired" };
    }

    const user = findUserById(database, session.userId);
    if (user === undefined) {
      this.#sessions.delete(key);
      return { kind: "refused", reason: "unknown-account" };
    }
    if (user.disabledAt !== undefined) {
      this.#sessions.delete(key);
      return { kind: "refused", reason: "disabled" };
    }
    if (session.epoch < user.tokenEpoch) {
      this.#sessions.delete(key);
      return { kind: "refused", reason: "revoked" };
    }

    return { kind: "identified", user, expiresAt: session.expiresAt };
  }

  /** Close one session, if it is one. Signing out must not say whether it was. */
  close(secret: string | undefined): void {
    if (secret === undefined || secret === "") {
      return;
    }
    this.#sessions.delete(fingerprint(secret));
  }

  /** Close every session this account has open, wherever it has one. */
  closeEvery(userId: string): void {
    for (const [key, session] of this.#sessions) {
      if (session.userId === userId) {
        this.#sessions.delete(key);
      }
    }
  }

  /** Drop what has expired, so an idle server does not hold sessions for ever. */
  #sweep(): void {
    const now = this.#now();
    for (const [key, session] of this.#sessions) {
      if (session.expiresAt <= now) {
        this.#sessions.delete(key);
      }
    }
  }
}

/**
 * The value of one cookie out of a `cookie` header.
 *
 * Written out rather than taken from a library, and stricter than the header
 * allows: a name is compared whole, so `xnlteam_session` cannot be read as
 * `nlteam_session`, and the first match wins because a browser sending two of
 * the same name has sent one this server set and one somebody else did.
 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return undefined;
}

/**
 * The `set-cookie` line that puts a session in a browser.
 *
 * Every attribute here is doing something:
 *
 *   - `HttpOnly` keeps it out of `document.cookie`, so a script that got itself
 *     onto the page cannot read it out.
 *   - `Secure` keeps it off a plaintext connection. This endpoint only exists
 *     over TLS, so it costs nothing and is true whatever a future listener does.
 *   - `SameSite=Strict` is what stops another site's page making a request that
 *     carries this cookie. Together with refusing a write that did not arrive as
 *     `application/json`, it is the whole of the cross-site story: there are no
 *     forms here and no CORS headers anywhere, so nothing else can reach the API.
 *   - `Path=/` because the interface and its API share an origin.
 */
export function sessionCookie(secret: string, expiresAt: number, now: number): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - now) / 1000));
  return [
    `${SESSION_COOKIE}=${secret}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

/** The `set-cookie` line that takes it away again. */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

/**
 * Compare two secrets without letting the clock say how far they matched.
 *
 * Not used for the session cookie, which is found by hash in a map, but for the
 * places a short secret is compared whole. Lengths that differ are answered
 * false before `timingSafeEqual`, which throws on them.
 */
export function secretsMatch(one: string, other: string): boolean {
  const a = Buffer.from(one, "utf8");
  const b = Buffer.from(other, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
