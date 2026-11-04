// Small image files built in the test from their headers, so the size reader is checked against bytes whose size is known.
import { deflateSync } from "node:zlib";

const u16be = (n: number) => Buffer.from([n >> 8, n & 0xff]);
const u32be = (n: number) => Buffer.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const u16le = (n: number) => Buffer.from([n & 0xff, n >> 8]);
const u24le = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);
const u32le = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);

export function png(width: number, height: number, padding = 0): Buffer {
  const header = Buffer.concat([u32be(width), u32be(height), Buffer.from([8, 2, 0, 0, 0])]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    u32be(13),
    Buffer.from("IHDR"),
    header,
    u32be(0),
    u32be(2),
    Buffer.from("IDAT"),
    deflateSync(Buffer.alloc(3)),
    Buffer.alloc(padding, 1),
  ]);
}

const segment = (marker: number, body: Buffer) =>
  Buffer.concat([Buffer.from([0xff, marker]), u16be(body.length + 2), body]);

/** A JPEG with an EXIF segment, a quantization table and a Huffman table before the frame header, as a camera writes it. */
export function jpeg(width: number, height: number, frame = 0xc0): Buffer {
  const exif = Buffer.concat([Buffer.from("Exif\0\0"), Buffer.alloc(300, 0xff)]);
  const sof = Buffer.concat([
    Buffer.from([8]),
    u16be(height),
    u16be(width),
    Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
  ]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xe1, exif),
    Buffer.from([0xff, 0xff]),
    segment(0xdb, Buffer.alloc(65, 3)),
    segment(0xc4, Buffer.alloc(20, 4)),
    segment(frame, sof),
    Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9]),
  ]);
}

export function gif(width: number, height: number): Buffer {
  return Buffer.concat([Buffer.from("GIF89a"), u16le(width), u16le(height), Buffer.from([0, 0, 0, 0x3b])]);
}

const riff = (chunk: string, payload: Buffer) => {
  const body = Buffer.concat([Buffer.from("WEBP"), Buffer.from(chunk), u32le(payload.length), payload]);
  return Buffer.concat([Buffer.from("RIFF"), u32le(body.length), body]);
};

/** A lossy WebP: the frame tag, the start code, then 14-bit width and height. */
export function webpLossy(width: number, height: number): Buffer {
  return riff(
    "VP8 ",
    Buffer.concat([
      Buffer.from([0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a]),
      u16le(width),
      u16le(height),
      Buffer.alloc(8),
    ]),
  );
}

/** A lossless WebP: a signature byte, then width - 1 and height - 1 in 14 bits each. */
export function webpLossless(width: number, height: number): Buffer {
  const w = width - 1;
  const h = height - 1;
  const bits = Buffer.from([
    w & 0xff,
    ((w >> 8) & 0x3f) | ((h & 0x03) << 6),
    (h >> 2) & 0xff,
    (h >> 10) & 0x0f,
  ]);
  return riff("VP8L", Buffer.concat([Buffer.from([0x2f]), bits, Buffer.alloc(8)]));
}

/** An extended WebP: flags, then width - 1 and height - 1 in 24 bits each. */
export function webpExtended(width: number, height: number): Buffer {
  return riff("VP8X", Buffer.concat([Buffer.alloc(4), u24le(width - 1), u24le(height - 1), Buffer.alloc(8)]));
}

export const svg = (attributes: string, inner = "<rect width='1' height='1'/>") =>
  Buffer.from(`<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" ${attributes}>${inner}</svg>`);
