// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** Deterministic PNG encoding and decoding (8-bit RGB or RGBA, non-interlaced), with Node's zlib. */
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Applies filter 4 (Paeth) to every row; a fixed filter keeps the output deterministic and compact for imagery. */
function filterRows(pixels: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;
  const out = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    out[y * (stride + 1)] = 4;
    for (let i = 0; i < stride; i++) {
      const at = y * stride + i;
      const a = i >= channels ? (pixels[at - channels] ?? 0) : 0;
      const b = y > 0 ? (pixels[at - stride] ?? 0) : 0;
      const c = i >= channels && y > 0 ? (pixels[at - stride - channels] ?? 0) : 0;
      out[y * (stride + 1) + 1 + i] = ((pixels[at] ?? 0) - paeth(a, b, c)) & 0xff;
    }
  }
  return out;
}

/** Encodes 8-bit RGB (3 channels) or RGBA (4 channels) pixels as PNG. */
export function encodePng(pixels: Uint8Array, width: number, height: number, channels: 3 | 4): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, channels === 4 ? 6 : 2, 0, 0, 0], 8);
  const idat = deflateSync(filterRows(pixels, width, height, channels), { level: 9 });
  const parts = [SIGNATURE, chunk('IHDR', header), chunk('IDAT', idat), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A decoded PNG. */
export interface DecodedPng {
  width: number;
  height: number;
  channels: number;
  pixels: Uint8Array;
}

function unfilter(data: Uint8Array, width: number, height: number, channels: number): Uint8Array {
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const type = data[y * (stride + 1)] ?? 0;
    for (let i = 0; i < stride; i++) {
      const at = y * stride + i;
      const a = i >= channels ? (out[at - channels] ?? 0) : 0;
      const b = y > 0 ? (out[at - stride] ?? 0) : 0;
      const c = i >= channels && y > 0 ? (out[at - stride - channels] ?? 0) : 0;
      const predictors = [0, a, b, (a + b) >> 1, paeth(a, b, c)];
      out[at] = ((data[y * (stride + 1) + 1 + i] ?? 0) + (predictors[type] ?? 0)) & 0xff;
    }
  }
  return out;
}

/** Decodes an 8-bit, non-interlaced grey, RGB or RGBA PNG. */
export function decodePng(bytes: Uint8Array): DecodedPng {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  while (at < bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[data[9] ?? 0] ?? 0;
      if (data[8] !== 8 || channels === 0 || data[12] !== 0) throw new Error('PNG: only 8-bit, non-interlaced');
    } else if (type === 'IDAT') idat.push(data);
    at += 12 + length;
  }
  const joined = Buffer.concat(idat);
  return { width, height, channels, pixels: unfilter(inflateSync(joined), width, height, channels) };
}
