/** Deterministic gzip: a fixed header (mtime 0, OS byte 255) around raw DEFLATE, the same on every platform. */
import { deflateRawSync, gunzipSync } from 'node:zlib';
import { crc32 } from '../encode/png.js';

/** Gzips bytes deterministically. */
export function gzip(bytes: Uint8Array): Uint8Array {
  const body = deflateRawSync(bytes, { level: 9 });
  const out = new Uint8Array(10 + body.length + 8);
  out.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 0xff]);
  out.set(body, 10);
  const view = new DataView(out.buffer);
  view.setUint32(10 + body.length, crc32(bytes), true);
  view.setUint32(14 + body.length, bytes.length >>> 0, true);
  return out;
}

/** Gunzips bytes. */
export function gunzip(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(gunzipSync(bytes));
}
