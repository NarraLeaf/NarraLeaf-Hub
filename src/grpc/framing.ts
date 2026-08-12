/**
 * How a gRPC message sits inside an HTTP/2 stream.
 *
 * One message is five bytes of prefix and then its encoding: a compression
 * flag, then the length as four bytes big-endian. That is the whole framing —
 * a request or a reply of one message is one frame, and the HTTP/2 layer below
 * is free to split it across as many DATA frames as it likes, which is why
 * reassembly is a class rather than a function.
 *
 * The compression flag is written as 0 and refused when it is anything else.
 * Accepting it would mean claiming to understand a `grpc-encoding` this code
 * never negotiated, and answering with the compressed bytes read as a message
 * is worse than saying so.
 */
import { GRPC_RESOURCE_EXHAUSTED, GRPC_UNIMPLEMENTED, GrpcStatusError } from "./status.js";

/** The five bytes in front of every message. */
const PREFIX_BYTES = 5;

/**
 * The largest message either side will read.
 *
 * Four mebibytes is gRPC's own default limit. Nothing Hub exchanges comes near
 * it — the largest is a list of resource ids — and the point of the limit is
 * that a length field is a promise about memory made by whoever sent it.
 */
export const MAXIMUM_MESSAGE_BYTES = 4 * 1024 * 1024;

/** Put one message in a frame, ready to be written to a stream. */
export function encodeFrame(message: Uint8Array): Buffer {
  const frame = Buffer.allocUnsafe(PREFIX_BYTES + message.byteLength);
  frame.writeUInt8(0, 0);
  frame.writeUInt32BE(message.byteLength, 1);
  Buffer.from(message.buffer, message.byteOffset, message.byteLength).copy(frame, PREFIX_BYTES);
  return frame;
}

/**
 * Chunks of a stream as they arrive, turned back into whole messages.
 *
 * A caller pushes whatever the socket produced and is handed the messages that
 * are now complete, which may be none.
 */
export class FrameAssembler {
  #buffered: Buffer = Buffer.alloc(0);

  /** Take one chunk and return every message it completed. */
  push(chunk: Uint8Array): Buffer[] {
    this.#buffered = Buffer.concat([
      this.#buffered,
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
    ]);

    const messages: Buffer[] = [];
    while (this.#buffered.length >= PREFIX_BYTES) {
      const compressed = this.#buffered.readUInt8(0);
      if (compressed !== 0) {
        throw new GrpcStatusError(
          GRPC_UNIMPLEMENTED,
          "this message is compressed, and no compression was agreed for this call",
        );
      }
      const length = this.#buffered.readUInt32BE(1);
      if (length > MAXIMUM_MESSAGE_BYTES) {
        throw new GrpcStatusError(
          GRPC_RESOURCE_EXHAUSTED,
          `a message of ${length} bytes is larger than the ${MAXIMUM_MESSAGE_BYTES} this accepts`,
        );
      }
      if (this.#buffered.length < PREFIX_BYTES + length) {
        break;
      }
      messages.push(this.#buffered.subarray(PREFIX_BYTES, PREFIX_BYTES + length));
      this.#buffered = this.#buffered.subarray(PREFIX_BYTES + length);
    }
    return messages;
  }

  /**
   * True when bytes are held that are not yet a whole message.
   *
   * A stream that ends in this state ended in the middle of a message, which is
   * a different failure from a stream that carried none.
   */
  get incomplete(): boolean {
    return this.#buffered.length > 0;
  }
}
