// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Edge bleeding and PNG output of warped tiles (F226). Textures are filtered with straight (not premultiplied) alpha,
 * so a transparent texel's color leaks into its visible neighbors when sampled between them: a canvas leaves
 * transparent pixels black, which draws a dark line along every data edge, and the antialiased edge pixels' colors
 * come back from the canvas's premultiplied storage badly quantized (a stray color spot where two zones overlap).
 * Giving those pixels the color of their opaque neighbors removes both; a canvas cannot keep color at zero alpha, so
 * the tile is encoded as PNG here.
 */

/**
 * Gives each pixel that is not opaque, next to an opaque one, the alpha-weighted mean color of its opaque 8-neighbors,
 * `passes` times (each pass reaches one pixel further, covering the coarser mip levels). Alpha stays unchanged, and
 * translucent pixels away from opaque ones (a uniformly translucent layer) keep their color.
 */
export function bleedTransparentEdges(
  rgba: Uint8Array | Uint8ClampedArray,
  widthPx: number,
  heightPx: number,
  passes = 4,
): void {
  // Pixels holding a reliable color: opaque ones, then those filled by earlier passes.
  const colored = new Uint8Array(widthPx * heightPx);
  for (let p = 0; p < colored.length; p++) colored[p] = rgba[p * 4 + 3] === 255 ? 1 : 0;
  const filled: number[] = [];
  for (let pass = 0; pass < passes; pass++) {
    filled.length = 0;
    for (let y = 0; y < heightPx; y++) {
      for (let x = 0; x < widthPx; x++) {
        const p = y * widthPx + x;
        if (colored[p]) continue;
        let [r, g, b, weight] = [0, 0, 0, 0];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= widthPx || ny >= heightPx) continue;
            const q = ny * widthPx + nx;
            if (!colored[q]) continue;
            // Earlier passes' pixels may have zero alpha: weight them as barely visible.
            const w = Math.max(1, rgba[q * 4 + 3] ?? 0);
            r += (rgba[q * 4] ?? 0) * w;
            g += (rgba[q * 4 + 1] ?? 0) * w;
            b += (rgba[q * 4 + 2] ?? 0) * w;
            weight += w;
          }
        }
        if (weight === 0) continue;
        rgba[p * 4] = Math.round(r / weight);
        rgba[p * 4 + 1] = Math.round(g / weight);
        rgba[p * 4 + 2] = Math.round(b / weight);
        filled.push(p);
      }
    }
    if (filled.length === 0) break;
    for (const p of filled) colored[p] = 1;
  }
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encodes straight 8-bit RGBA pixels as PNG (filter 0, zlib through `CompressionStream`). */
export async function encodeRgbaPng(
  rgba: Uint8Array | Uint8ClampedArray,
  widthPx: number,
  heightPx: number,
): Promise<ArrayBuffer> {
  const stride = widthPx * 4;
  const raw = new Uint8Array((stride + 1) * heightPx);
  for (let y = 0; y < heightPx; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
  const idat = new Uint8Array(await new Response(stream).arrayBuffer());
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, widthPx);
  view.setUint32(4, heightPx);
  header.set([8, 6, 0, 0, 0], 8);
  const signature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const parts = [signature, chunk('IHDR', header), chunk('IDAT', idat), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out.buffer;
}
