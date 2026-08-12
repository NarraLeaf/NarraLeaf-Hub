/**
 * Hub's own HTTP endpoint.
 *
 * It serves two things and refuses everything else:
 *
 *     GET /.well-known/jwks.json   the public halves of the signing keys
 *     GET /health                  proof that this process is answering
 *
 * There is no user data here, nothing that writes, and no CORS headers: a
 * browser has no business calling this, and the one program that does —
 * loreserver, fetching the JWKS — is not a browser.
 *
 * Plain HTTP is deliberate. The document is a set of public keys, so there is
 * nothing in it to keep secret, and nothing an eavesdropper can do with it. A
 * verifier that fetched the keys over a tampered connection would be a problem,
 * which is why loreserver is pointed at the loopback address of the machine Hub
 * runs on rather than across a network.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { JwksDocument } from "./keys.js";

/** What the endpoint needs to answer with. */
export interface EndpointOptions {
  readonly port: number;
  /**
   * Interface to listen on. The loopback by default: the only caller is a
   * loreserver Hub started itself, on this machine.
   */
  readonly host?: string;
  /**
   * Consulted per request, so a rotation is served without a restart. It may
   * do work — reading the keys directory again, for instance — which is why it
   * is allowed to be asynchronous.
   */
  readonly jwks: () => JwksDocument | Promise<JwksDocument>;
  /** Reported by `/health`. */
  readonly version: string;
}

/** Raised when the endpoint could not take its port. */
export class EndpointListenError extends Error {
  constructor(address: string, cause: Error) {
    super(
      `Hub's endpoint could not listen on ${address}: ${cause.message}. ` +
        "Another program may hold that port; --hub-port moves it.",
      { cause },
    );
    this.name = "EndpointListenError";
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    // A JWKS that a verifier holds on to after a key is retired is a token
    // that verifies when it should not. Caching it is the verifier's decision
    // to make deliberately, not one Hub makes for it by saying nothing.
    "cache-control": "no-store",
  });
  response.end(text);
}

/** Hub's HTTP endpoint, listening. */
export class IdentityEndpoint {
  readonly #server: Server;
  readonly #host: string;
  readonly #port: number;

  private constructor(server: Server, host: string, port: number) {
    this.#server = server;
    this.#host = host;
    this.#port = port;
  }

  /** Start listening, or fail saying why. */
  static async start(options: EndpointOptions): Promise<IdentityEndpoint> {
    const host = options.host ?? "127.0.0.1";
    const server = createServer((request, response) => {
      handle(request, response, options);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(new EndpointListenError(`${host}:${options.port}`, error));
      };
      server.once("error", onError);
      server.listen(options.port, host, () => {
        server.removeListener("error", onError);
        resolve();
      });
    });

    // Port 0 means "any free port", and the number it landed on is only
    // knowable afterwards. Reading it back means the address reported is the
    // one that works, whichever was asked for.
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : options.port;
    return new IdentityEndpoint(server, host, port);
  }

  /** Where it is listening, as it is written in a URL. */
  get url(): string {
    return `http://${this.#host}:${this.#port}`;
  }

  /**
   * Stop listening and return once nothing is left open.
   *
   * Open keep-alive connections are closed rather than waited for: a client
   * holding one would otherwise keep the process alive after the operator has
   * asked it to stop.
   */
  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
      this.#server.closeAllConnections();
    });
  }
}

/** Answer one request. */
function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: EndpointOptions,
): void {
  // The path is taken apart with the URL parser rather than compared as a
  // string, so a query string or an escaped separator cannot make one route
  // look like another.
  const path = new URL(request.url ?? "/", "http://hub.invalid").pathname;

  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "only GET is served here" });
    return;
  }

  switch (path) {
    case "/.well-known/jwks.json":
      void Promise.resolve(options.jwks()).then(
        (document) => {
          sendJson(response, 200, document);
        },
        (error: unknown) => {
          // The keys could not be read. Saying so beats an open connection
          // that never answers, and there is nothing here worth hiding: a
          // verifier that cannot fetch the keys is going to fail anyway.
          sendJson(response, 500, {
            error: `the signing keys could not be read: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        },
      );
      return;
    case "/health":
      sendJson(response, 200, { ok: true, version: options.version });
      return;
    default:
      sendJson(response, 404, { error: "not found" });
  }
}
