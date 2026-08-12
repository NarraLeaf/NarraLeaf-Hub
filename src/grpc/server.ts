/**
 * A gRPC server, on HTTP/2 without TLS.
 *
 * gRPC is HTTP/2 with four conventions on top: the method is POST, the path is
 * `/package.Service/Method`, the body is framed as src/grpc/framing.ts
 * describes, and the outcome is a `grpc-status` trailer rather than a status
 * code. That is the whole of what this implements, for calls of one message in
 * each direction — the only shape either service Hub serves uses.
 *
 * Plaintext is not a shortcut taken here. loreserver connects to the address in
 * its `auth_url`, which is the loopback of the machine Hub started it on, and it
 * was measured to speak h2c there with no certificate involved. What travels is
 * a token the caller already holds and a list of resource ids, over a socket
 * nothing off the machine can reach.
 */
import {
  createServer,
  type Http2Server,
  type IncomingHttpHeaders,
  type ServerHttp2Stream,
  type ServerHttp2Session,
} from "node:http2";

import { encodeFrame, FrameAssembler } from "./framing.js";
import {
  encodeStatusMessage,
  GRPC_INTERNAL,
  GRPC_INVALID_ARGUMENT,
  GRPC_OK,
  GRPC_UNIMPLEMENTED,
  GrpcStatusError,
} from "./status.js";

/** One call, as a method sees it. */
export interface GrpcCall {
  /** `/package.Service/Method`, exactly as it arrived. */
  readonly path: string;
  /** The `authorization` header, whatever it held, or undefined for none. */
  readonly authorization: string | undefined;
  /** The one request message, decoded out of its frame. */
  readonly message: Buffer;
  /** Where the call came from, for a log line. */
  readonly peer: string;
}

/** What a method does with a call: answer with one message, or fail. */
export type GrpcMethod = (call: GrpcCall) => Buffer | Promise<Buffer>;

/** What a server needs to answer. */
export interface GrpcServerOptions {
  readonly port: number;
  /** Interface to listen on; the loopback by default. */
  readonly host?: string;
  /** Methods by full path. Anything else is answered `UNIMPLEMENTED`. */
  readonly methods: Readonly<Record<string, GrpcMethod>>;
  /**
   * Called for a failure that belongs to no call — a broken session, a socket
   * that died mid-reply. Without one, such a failure is swallowed, because
   * there is nobody left to answer.
   */
  readonly onError?: (error: Error) => void;
}

/** Raised when the server could not take its port. */
export class GrpcListenError extends Error {
  constructor(address: string, cause: Error) {
    super(
      `Hub's authorization service could not listen on ${address}: ${cause.message}. ` +
        "Another program may hold that port; --auth-port moves it.",
      { cause },
    );
    this.name = "GrpcListenError";
  }
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** End a call with a status and no message. */
function respondWithStatus(stream: ServerHttp2Stream, status: number, message: string): void {
  if (stream.destroyed || stream.headersSent) {
    return;
  }
  // A "Trailers-Only" reply: one HEADERS frame carrying both the HTTP status
  // and the gRPC status, and no body at all. The protocol allows it for a call
  // that failed before anything was produced, and a client reads the outcome
  // from these headers rather than waiting for trailers that never come.
  stream.respond(
    {
      ":status": 200,
      "content-type": "application/grpc",
      "grpc-status": String(status),
      "grpc-message": encodeStatusMessage(message),
    },
    { endStream: true },
  );
}

/** End a call with one message and a status of OK. */
function respondWithMessage(stream: ServerHttp2Stream, message: Uint8Array): void {
  if (stream.destroyed || stream.headersSent) {
    return;
  }
  stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
  stream.once("wantTrailers", () => {
    stream.sendTrailers({ "grpc-status": String(GRPC_OK) });
  });
  stream.end(encodeFrame(message));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read one request's single message, then run its method and answer. */
function handleStream(
  stream: ServerHttp2Stream,
  headers: IncomingHttpHeaders,
  options: GrpcServerOptions,
): void {
  const path = headerValue(headers, ":path") ?? "";
  const method = options.methods[path];
  const assembler = new FrameAssembler();
  const messages: Buffer[] = [];

  // A stream can fail at any point — the peer going away mid-call is ordinary.
  // Without this listener the failure is thrown at the process instead.
  stream.on("error", (error: Error) => {
    options.onError?.(error);
  });

  if (headerValue(headers, ":method") !== "POST") {
    respondWithStatus(stream, GRPC_UNIMPLEMENTED, "a gRPC call is a POST");
    return;
  }
  if (method === undefined) {
    respondWithStatus(stream, GRPC_UNIMPLEMENTED, `${path} is not a method this service serves`);
    return;
  }

  stream.on("data", (chunk: Buffer) => {
    try {
      messages.push(...assembler.push(chunk));
    } catch (error) {
      const status = error instanceof GrpcStatusError ? error.status : GRPC_INTERNAL;
      respondWithStatus(stream, status, describe(error));
      stream.close();
    }
  });

  stream.on("end", () => {
    if (stream.destroyed || stream.headersSent) {
      return;
    }
    const message = messages[0];
    if (message === undefined || assembler.incomplete) {
      respondWithStatus(
        stream,
        GRPC_INVALID_ARGUMENT,
        assembler.incomplete
          ? "the request ended in the middle of a message"
          : "the request carried no message",
      );
      return;
    }

    const call: GrpcCall = {
      path,
      authorization: headerValue(headers, "authorization"),
      message,
      peer: `${stream.session?.socket.remoteAddress ?? "?"}:${
        stream.session?.socket.remotePort ?? 0
      }`,
    };

    void (async () => {
      try {
        respondWithMessage(stream, await method(call));
      } catch (error) {
        // A method that raises has already decided nothing is being sent, so
        // the failure becomes the whole reply. Anything that is not a status
        // of its own is INTERNAL: it is a fault in Hub, not in the request.
        const status = error instanceof GrpcStatusError ? error.status : GRPC_INTERNAL;
        respondWithStatus(stream, status, describe(error));
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}

/** A gRPC server, listening. */
export class GrpcServer {
  readonly #server: Http2Server;
  readonly #sessions: Set<ServerHttp2Session>;
  readonly #host: string;
  readonly #port: number;

  private constructor(
    server: Http2Server,
    sessions: Set<ServerHttp2Session>,
    host: string,
    port: number,
  ) {
    this.#server = server;
    this.#sessions = sessions;
    this.#host = host;
    this.#port = port;
  }

  /** Start listening, or fail saying why. */
  static async start(options: GrpcServerOptions): Promise<GrpcServer> {
    const host = options.host ?? "127.0.0.1";
    const server = createServer();
    const sessions = new Set<ServerHttp2Session>();

    server.on("session", (session: ServerHttp2Session) => {
      sessions.add(session);
      session.on("close", () => sessions.delete(session));
      session.on("error", (error: Error) => options.onError?.(error));
    });
    server.on("stream", (stream, headers) => {
      handleStream(stream, headers, options);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(new GrpcListenError(`${host}:${options.port}`, error));
      };
      server.once("error", onError);
      server.listen(options.port, host, () => {
        server.removeListener("error", onError);
        resolve();
      });
    });

    // Port 0 means "any free port", and which one it landed on is only knowable
    // afterwards, which is how a test gets an address that cannot collide.
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : options.port;
    return new GrpcServer(server, sessions, host, port);
  }

  /** The port it is listening on. */
  get port(): number {
    return this.#port;
  }

  /** Where it is listening, as a caller writes it. */
  get url(): string {
    return `http://${this.#host}:${this.#port}`;
  }

  /**
   * Stop listening and return once nothing is left open.
   *
   * gRPC clients hold their connection open between calls, so the sessions are
   * destroyed rather than waited for; one idle client would otherwise keep the
   * process alive after the operator has asked it to stop.
   */
  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
      for (const session of this.#sessions) {
        session.destroy();
      }
      this.#sessions.clear();
    });
  }
}
