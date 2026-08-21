/**
 * The framing, on its own.
 *
 * A session test drives this through a real socket and a real client, which is
 * the right way to know the protocol works. It is the wrong way to know what
 * happens to a frame with a reserved bit set, a message that arrives in three
 * pieces, or a client that forgot to mask - because a well-behaved client never
 * sends any of those, and this is where a peer that is wrong or hostile is
 * dealt with.
 *
 * So this drives the connection directly, with bytes.
 */
import { Duplex } from "node:stream";

import { describe, expect, it } from "vitest";

import { acceptKey, CLOSE, WebSocketConnection } from "../src/team/websocket.js";

/** A socket whose two directions a test drives by hand. */
class FakeSocket extends Duplex {
  readonly written: Buffer[] = [];

  override _read(): void {
    // Nothing is ever read out of this: the connection listens for `data`,
    // which the test emits.
  }

  override _write(chunk: Buffer, _encoding: string, done: () => void): void {
    this.written.push(Buffer.from(chunk));
    done();
  }

  /** Pretend these bytes arrived from the peer. */
  feed(...bytes: Buffer[]): void {
    for (const chunk of bytes) {
      this.emit("data", chunk);
    }
  }

  /** Everything the connection has written, as one buffer. */
  get output(): Buffer {
    return Buffer.concat(this.written);
  }
}

/** One client frame, masked as the specification requires of a client. */
function clientFrame(opcode: number, payload: Buffer, final = true): Buffer {
  const mask = Buffer.from([0x0a, 0x1b, 0x2c, 0x3d]);
  const masked = Buffer.allocUnsafe(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = (payload[index] as number) ^ (mask[index % 4] as number);
  }
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([(final ? 0x80 : 0x00) | opcode, 0x80 | payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = (final ? 0x80 : 0x00) | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  return Buffer.concat([header, mask, masked]);
}

function text(value: string, final = true, opcode = 0x1): Buffer {
  return clientFrame(opcode, Buffer.from(value, "utf-8"), final);
}

interface Driven {
  readonly socket: FakeSocket;
  readonly messages: string[];
  readonly closes: string[];
  readonly connection: WebSocketConnection;
}

function drive(maximumMessageBytes = 1024): Driven {
  const socket = new FakeSocket();
  const messages: string[] = [];
  const closes: string[] = [];
  const connection = new WebSocketConnection(socket, Buffer.alloc(0), {
    maximumMessageBytes,
    // Long enough that no test in here ever reaches it.
    heartbeatMs: 60_000,
    onMessage: (value) => messages.push(value),
    onClose: (reason) => closes.push(reason),
  });
  return { socket, messages, closes, connection };
}

/** The close code out of a close frame the server wrote, or undefined. */
function closeCode(output: Buffer): number | undefined {
  for (let index = 0; index + 4 <= output.length; index += 1) {
    if (output[index] === 0x88) {
      return output.readUInt16BE(index + 2);
    }
  }
  return undefined;
}

describe("the handshake", () => {
  it("answers the key with what the specification says", () => {
    // The example from RFC 6455 §1.3, which is the one value everybody's
    // implementation has been checked against since 2011.
    expect(acceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });
});

describe("reading frames", () => {
  it("hands over a whole message", () => {
    const driven = drive();
    driven.socket.feed(text('{"t":"call"}'));
    expect(driven.messages).toEqual(['{"t":"call"}']);
  });

  it("waits for the rest of a frame that arrived in pieces", () => {
    const driven = drive();
    const frame = text("hello");
    driven.socket.feed(frame.subarray(0, 3));
    expect(driven.messages).toEqual([]);
    driven.socket.feed(frame.subarray(3));
    expect(driven.messages).toEqual(["hello"]);
  });

  it("joins a message that was sent as fragments", () => {
    const driven = drive();
    driven.socket.feed(text("one ", false), text("two ", false, 0x0), text("three", true, 0x0));
    expect(driven.messages).toEqual(["one two three"]);
  });

  it("refuses a frame a client did not mask", () => {
    const driven = drive();
    // Unmasked is what a server sends. A client that does it is either broken
    // or is trying to get a proxy to cache something.
    driven.socket.feed(Buffer.concat([Buffer.from([0x81, 0x02]), Buffer.from("hi")]));
    expect(driven.messages).toEqual([]);
    expect(closeCode(driven.socket.output)).toBe(CLOSE.protocolError);
  });

  it("refuses a reserved bit, because no extension was agreed", () => {
    const driven = drive();
    const frame = text("hi");
    frame[0] = (frame[0] as number) | 0x40;
    driven.socket.feed(frame);
    expect(closeCode(driven.socket.output)).toBe(CLOSE.protocolError);
  });

  it("refuses a message larger than it will hold", () => {
    const driven = drive(16);
    driven.socket.feed(text("a".repeat(64)));
    expect(driven.messages).toEqual([]);
    expect(closeCode(driven.socket.output)).toBe(CLOSE.tooLarge);
  });

  it("refuses fragments that add up to more than it will hold", () => {
    // The point of counting fragments rather than frames: eight frames of
    // fifty bytes are not eight small messages.
    const driven = drive(120);
    driven.socket.feed(text("a".repeat(50), false));
    driven.socket.feed(text("b".repeat(50), false, 0x0));
    driven.socket.feed(text("c".repeat(50), true, 0x0));
    expect(driven.messages).toEqual([]);
    expect(closeCode(driven.socket.output)).toBe(CLOSE.tooLarge);
  });

  it("refuses a binary frame, because this protocol is text", () => {
    const driven = drive();
    driven.socket.feed(clientFrame(0x2, Buffer.from([1, 2, 3])));
    expect(closeCode(driven.socket.output)).toBe(CLOSE.unsupportedData);
  });

  it("answers a ping with the same bytes", () => {
    const driven = drive();
    driven.socket.feed(clientFrame(0x9, Buffer.from("beat")));
    const output = driven.socket.output;
    expect(output[0]).toBe(0x8a);
    expect(output.subarray(2).toString("utf-8")).toBe("beat");
  });

  it("says a client that closed is closed, once", () => {
    const driven = drive();
    driven.socket.feed(clientFrame(0x8, Buffer.alloc(0)));
    driven.socket.emit("close");
    expect(driven.closes).toHaveLength(1);
  });
});

describe("writing frames", () => {
  it("does not mask, because a server that masks is one nobody reads", () => {
    const driven = drive();
    driven.connection.send("hi");
    const output = driven.socket.output;
    expect(output[0]).toBe(0x81);
    // The length byte carries no mask bit, and the payload follows immediately.
    expect(output[1]).toBe(2);
    expect(output.subarray(2).toString("utf-8")).toBe("hi");
  });

  it("uses the longer length field for a message that needs it", () => {
    const driven = drive(1024 * 1024);
    driven.connection.send("x".repeat(200));
    const output = driven.socket.output;
    expect(output[1]).toBe(126);
    expect(output.readUInt16BE(2)).toBe(200);
  });

  it("writes nothing once it has closed", () => {
    const driven = drive();
    driven.connection.close(CLOSE.normal, "done");
    const afterClose = driven.socket.written.length;
    driven.connection.send("anything");
    expect(driven.socket.written.length).toBe(afterClose);
  });

  it("cuts a close reason down rather than writing an illegal control frame", () => {
    const driven = drive();
    driven.connection.close(CLOSE.policy, "why ".repeat(80));
    const output = driven.socket.output;
    // Two bytes of header, then the code and the words: a control frame's
    // payload may not exceed 125.
    expect(output[1]).toBeLessThanOrEqual(125);
  });
});
