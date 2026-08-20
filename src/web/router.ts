/**
 * What answers an HTTP/1.1 request on the TLS listener.
 *
 * The listener speaks gRPC over h2 and has, until now, answered exactly one
 * HTTP/1.1 path: the discovery document. The web interface goes here rather
 * than on a port of its own, and the reason is the one written at the top of
 * src/identity/discovery.ts. **One listener, one certificate, and therefore one
 * decision to trust.** An operator has already been asked to compare a
 * fingerprint and run `nlteam trust`; a second port with a second certificate
 * would be a second such conversation, and a page served over plain HTTP beside
 * it would be a password typed into an unauthenticated connection.
 *
 * So this is a router with four arms, in the order they are tried:
 *
 *   - `/.well-known/nlteam`, which is served whether or not the interface is
 *     switched on and to whoever asks. It is what turns one address into a
 *     server, and the interface must never be able to get in its way.
 *   - `/api/studio/…`, which src/web/studio.ts answers. Also before the switch,
 *     and for the same reason: the interface is a page an operator opens, while
 *     that is how every Studio installation finds its work.
 *   - `/api/…`, which src/web/api.ts answers.
 *   - the pages themselves, which are four files and no routing: there is one
 *     page, and where somebody is in it is not a thing the server knows.
 */
import { serveDiscovery, type DiscoveryDocument } from "../identity/discovery.js";
import { languageOf, serveApi, type ApiOptions } from "./api.js";
import { staticAssets, WEB_BUILT } from "./assets.js";
import { serveStudioApi, type StudioApiOptions } from "./studio.js";

import type { IncomingMessage, ServerResponse } from "node:http";

/** How long a browser may keep a file before asking about it again. */
const ASSET_MAX_AGE_SECONDS = 300;

export interface WebOptions {
  /** Absent for a server told not to serve the interface. */
  readonly api?: ApiOptions;
  /** What a Studio installation talks to. Served whatever the interface is doing. */
  readonly studio?: StudioApiOptions;
}

/**
 * Serve one HTTP/1.1 request.
 *
 * Returned as a handler rather than exported as a function of many arguments,
 * because that is the shape the listener takes.
 *
 * The discovery document arrives as something to call rather than as a value.
 * Most of it is settled when `up` starts, but the name a server calls itself is
 * a stored setting — one somebody changes from another terminal while this
 * process is running — and a document composed once would go on announcing the
 * name that server had at boot.
 */
export function webHandler(
  discovery: () => DiscoveryDocument,
  options: WebOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  const assets = staticAssets();

  return (request, response) => {
    // Taken apart with the URL parser rather than compared as a string, so a
    // query string or an escaped separator cannot make one route look like
    // another. The same reasoning as src/identity/endpoint.ts.
    const path = new URL(request.url ?? "/", "http://team.invalid").pathname;

    if (path === "/.well-known/nlteam") {
      serveDiscovery(discovery(), request, response);
      return;
    }

    // Before the switch below, so that turning the operator's page off does not
    // take every Studio installation's list of projects with it.
    if (options.studio !== undefined && serveStudioApi(options.studio, request, response, path)) {
      return;
    }

    // These few answers are read by a person in a browser, so they are said in
    // whatever language that browser asks for. There is nothing else to go on
    // here — nobody is signed in, and the page that would have remembered a
    // choice is the page that is not being served.
    const messages = languageOf(request);

    const { api } = options;
    if (api === undefined) {
      // Not a 404: a 404 says this server has no such page, and it has one that
      // whoever started it turned off. An operator reading this in a browser
      // needs the flag, not a puzzle.
      sendText(response, 503, `${messages.refusal.interfaceIsOff}\n`);
      return;
    }

    if (serveApi(api, request, response, path)) {
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" });
      response.end(`${messages.refusal.methodNotAllowed}\n`);
      return;
    }

    if (!WEB_BUILT) {
      // A build of Team whose browser half was never built. It cannot happen to
      // anything installed — both halves are built by one command — but it can
      // happen to somebody running from a checkout, and an empty page would
      // look like a bug in the interface rather than a step not taken.
      sendText(response, 503, `${messages.refusal.noInterfaceBuilt}\n`);
      return;
    }

    const asset = assets.get(path);
    if (asset === undefined) {
      sendText(response, 404, `${messages.refusal.nothingAtThatAddress}\n`);
      return;
    }

    // A browser that already has this exact file is told so rather than sent it
    // again. The tag is over the contents, so a new build always sends.
    if (request.headers["if-none-match"] === asset.etag) {
      response.writeHead(304, { etag: asset.etag });
      response.end();
      return;
    }

    const body = Buffer.from(asset.body, "utf8");
    response.writeHead(200, {
      "content-type": asset.type,
      "content-length": body.length,
      etag: asset.etag,
      "cache-control": `private, max-age=${ASSET_MAX_AGE_SECONDS}`,
      // The interface is one origin's own page and has no business being framed
      // by another, and nothing here should ever be guessed at by content.
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  };
}

function sendText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}
