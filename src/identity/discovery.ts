/**
 * What a server answers about itself, before anybody has an account on it.
 *
 * **One address is the whole of what an author is given.** `nlteam://host:port` names
 * this endpoint, and reading this document is what turns it into everything else: where
 * to sign in, whether signing in is required at all, and which data remote the projects
 * live on. Studio never asks a person for a `lore://` address and never shows one - that
 * is a detail of the storage this server happens to run, and naming it in an interface
 * would make it something people learn and type.
 *
 * It is served on the TLS listener the auth endpoint already uses, over HTTP/1.1 while
 * gRPC continues on h2. One listener, one certificate, and therefore one decision to
 * trust: the document that says where to sign in arrives over the same connection whose
 * certificate the author has been asked about, rather than over a second one nobody
 * looked at.
 *
 * Nothing here is secret. It is what the operator would otherwise have written in a chat
 * message, and every field of it is checkable against the token that arrives later.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/** The path this document is served at, and the only path the HTTP/1.1 side answers. */
export const DISCOVERY_PATH = "/.well-known/nlteam";

/**
 * The shape of the document.
 *
 * `protocol` is a number rather than a range so that a client can say "this server speaks
 * something I do not" in one comparison. It changes only when a field an older client
 * relies on stops meaning what it meant.
 */
export interface DiscoveryDocument {
  readonly protocol: 1;
  /** What this deployment calls itself, for a list of servers a person reads. */
  readonly name: string;
  readonly auth: {
    /**
     * Whether a token is needed to reach the projects.
     *
     * False for a server whose loreserver was configured without identity: it accepts
     * anyone who can reach it, and asking its authors for a token would be asking for
     * something nobody can issue.
     */
    readonly required: boolean;
    /** Where a token is presented, e.g. `https://team.example.lan:41402`. */
    readonly url: string;
  };
  readonly data: {
    /** The remote the repositories live on. Studio stores it and shows it to nobody. */
    readonly url: string;
  };
  /**
   * What this build of Team serves a Studio installation, by name.
   *
   * Additive, and it does not move `protocol`. An older client that has never
   * heard of this field ignores it and asks for what it has always asked for,
   * which is the behaviour wanted: `protocol` says what an old client can no
   * longer rely on, and nothing here takes anything away.
   *
   * A newer client matches these strings literally and asks for nothing it did
   * not find one for, so a route added to a later Team is a route Studio waits
   * to see rather than one it has to discover by getting a 404. The list is
   * built from what this build answers — see {@link studioCapabilities} in
   * src/web/studio.ts, which is the same file that decides it.
   */
  readonly capabilities: readonly string[];
  readonly authority: {
    /**
     * SHA-256 of the authority this endpoint's certificate chains to.
     *
     * Present so that a client which has already trusted this server can tell, before
     * anything else happens, that the machine answering is the one it trusted. It proves
     * nothing on its own - it arrives over the connection it describes - and the interface
     * treats it as a label rather than as evidence.
     */
    readonly sha256: string;
  };
  /** The server's own version, for a support conversation rather than for a decision. */
  readonly version: string;
}

/**
 * Answer the discovery request, and nothing else.
 *
 * Every other path is a 404 rather than a redirect or an index: this listener exists to
 * speak gRPC, and the one document it serves over HTTP/1.1 is the exception rather than
 * the start of a web interface.
 */
export function serveDiscovery(
  document: DiscoveryDocument,
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const path = new URL(request.url ?? "/", "http://team.invalid").pathname;
  if (path !== DISCOVERY_PATH) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found\n");
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
    response.end("method not allowed\n");
    return;
  }

  const body = `${JSON.stringify(document, null, 2)}\n`;
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    // Read once, at the moment somebody types an address. A cached copy would answer for
    // a deployment that has since moved its data port.
    "cache-control": "no-store",
  });
  response.end(request.method === "HEAD" ? undefined : body);
}
