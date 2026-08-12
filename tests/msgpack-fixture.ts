// Building MessagePack for the tests that need some.
//
// Separate from what src reads, and on purpose: a reader tested only against
// bytes written by its own mirror image agrees with itself about everything,
// including whatever both of them get wrong. So this writes the format the
// specification describes, in the shortest form for each value, and the test
// beside it also reads a project file a real Studio wrote — which is the one
// check neither of these two could fake between them.
import { Buffer } from "node:buffer";

/** A real project file, as Studio wrote it, base64 of 628 bytes. */
export const REAL_PROJECT_FILE_BASE64 =
  "hKRuYW1lqFNrZWxldG9uqmlkZW50aWZpZXKtc2tlbGV0b24tZGVtb6htZXRhZGF0YYarZGVzY3Jp" +
  "cHRpb27ZNkEgc21hbGwsIGNvbXBsZXRlIHZpc3VhbCBub3ZlbCB0byByZWFkIGFuZCB0YWtlIGFw" +
  "YXJ0LqZhdXRob3Kgp2xpY2Vuc2WgrWxpY2Vuc2VTdHJpbmegqnJlc29sdXRpb26CpXdpZHRozQeA" +
  "pmhlaWdodM0EOKVpY29uc4SndmVyc2lvbgKmbWFzdGVywKVzcGVjc4albWFjb3ODqG92ZXJyaWRl" +
  "wKVpbnNldMs/uZmZmZmZmqpiYWNrZ3JvdW5kwKd3aW5kb3dzg6hvdmVycmlkZcClaW5zZXQAqmJh" +
  "Y2tncm91bmTApWxpbnV4g6hvdmVycmlkZcClaW5zZXQAqmJhY2tncm91bmTAp2FuZHJvaWSDqG92" +
  "ZXJyaWRlwKVpbnNldMs/tHrhR64Ue6piYWNrZ3JvdW5kwKNpb3ODqG92ZXJyaWRlwKVpbnNldACq" +
  "YmFja2dyb3VuZKcjRkZGRkZGo3dlYoOob3ZlcnJpZGXApWluc2V0AKpiYWNrZ3JvdW5kwKViYWtl" +
  "ZICjYXBwgqduZXR3b3Jrg6lhbGxvd0h0dHDCs2FsbG93UmVtb3RlUmVzb3VyY2XCsWFsbG93UmVt" +
  "b3RlU2NyaXB0wqxsb2NhbGl6YXRpb26CrHNvdXJjZUxvY2FsZaJlbqdsb2NhbGVzkoKkY29kZaJl" +
  "bqtkaXNwbGF5TmFtZadFbmdsaXNogqRjb2RlpXpoLUNOq2Rpc3BsYXlOYW1lrOeugOS9k+S4reaW" +
  "hw==";

export function realProjectFile(): Buffer {
  return Buffer.from(REAL_PROJECT_FILE_BASE64, "base64");
}

/** Write one value. Enough of the format for a project file and no more. */
export function encodeMsgpack(value: unknown): Buffer {
  return Buffer.concat(write(value));
}

function write(value: unknown): Buffer[] {
  if (value === null || value === undefined) {
    return [Buffer.from([0xc0])];
  }
  if (typeof value === "boolean") {
    return [Buffer.from([value ? 0xc3 : 0xc2])];
  }
  if (typeof value === "number") {
    return [writeNumber(value)];
  }
  if (typeof value === "string") {
    return writeString(value);
  }
  if (Array.isArray(value)) {
    return [writeHeader(value.length, 0x90, 0xdc, 0xdd), ...value.flatMap(write)];
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return [
      writeHeader(entries.length, 0x80, 0xde, 0xdf),
      ...entries.flatMap(([key, held]) => [...writeString(key), ...write(held)]),
    ];
  }
  throw new TypeError(`nothing here writes a ${typeof value}`);
}

function writeNumber(value: number): Buffer {
  if (Number.isInteger(value) && value >= 0 && value <= 0x7f) {
    return Buffer.from([value]);
  }
  if (Number.isInteger(value) && value >= 0 && value <= 0xffff) {
    const bytes = Buffer.alloc(3);
    bytes.writeUInt8(0xcd, 0);
    bytes.writeUInt16BE(value, 1);
    return bytes;
  }
  if (Number.isInteger(value) && value >= -0x80 && value < 0) {
    const bytes = Buffer.alloc(2);
    bytes.writeUInt8(0xd0, 0);
    bytes.writeInt8(value, 1);
    return bytes;
  }
  const bytes = Buffer.alloc(9);
  bytes.writeUInt8(0xcb, 0);
  bytes.writeDoubleBE(value, 1);
  return bytes;
}

function writeString(value: string): Buffer[] {
  const utf8 = Buffer.from(value, "utf-8");
  if (utf8.length <= 31) {
    return [Buffer.from([0xa0 | utf8.length]), utf8];
  }
  if (utf8.length <= 0xff) {
    return [Buffer.from([0xd9, utf8.length]), utf8];
  }
  const header = Buffer.alloc(3);
  header.writeUInt8(0xda, 0);
  header.writeUInt16BE(utf8.length, 1);
  return [header, utf8];
}

function writeHeader(length: number, fixed: number, medium: number, large: number): Buffer {
  if (length <= 15) {
    return Buffer.from([fixed | length]);
  }
  if (length <= 0xffff) {
    const bytes = Buffer.alloc(3);
    bytes.writeUInt8(medium, 0);
    bytes.writeUInt16BE(length, 1);
    return bytes;
  }
  const bytes = Buffer.alloc(5);
  bytes.writeUInt8(large, 0);
  bytes.writeUInt32BE(length, 1);
  return bytes;
}
