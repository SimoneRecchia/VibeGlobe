// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * A baseline JPEG encoder written from ITU-T T.81: YCbCr 4:4:4, the Annex K example quantization tables scaled by
 * quality, and the Annex K example Huffman tables. Deterministic for a given input and quality.
 */

const ZIGZAG = Uint8Array.from([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47,
  55, 62, 63,
]);
const LUMA_Q = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51,
  87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];
const CHROMA_Q = [
  17,
  18,
  24,
  47,
  99,
  99,
  99,
  99,
  18,
  21,
  26,
  66,
  99,
  99,
  99,
  99,
  24,
  26,
  56,
  99,
  99,
  99,
  99,
  99,
  47,
  66,
  99,
  99,
  99,
  99,
  99,
  99,
  ...new Array<number>(32).fill(99),
];

/** Huffman table specification: code counts per length 1–16, then symbols. */
interface HuffmanSpec {
  counts: number[];
  symbols: number[];
}

const DC_LUMA: HuffmanSpec = { counts: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], symbols: range(12) };
const DC_CHROMA: HuffmanSpec = { counts: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], symbols: range(12) };
const AC_LUMA: HuffmanSpec = {
  counts: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  symbols: hex(
    '01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9fa',
  ),
};
const AC_CHROMA: HuffmanSpec = {
  counts: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  symbols: hex(
    '000102031104052131061241510761711322328108144291a1b1c109233352f0156272d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a636465666768696a737475767778797a82838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9fa',
  ),
};

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

function hex(text: string): number[] {
  return Array.from({ length: text.length / 2 }, (_, i) => parseInt(text.slice(i * 2, i * 2 + 2), 16));
}

/** Code and length per symbol (T.81 Annex C). */
function buildCodes(spec: HuffmanSpec): { code: Uint16Array; size: Uint8Array } {
  const code = new Uint16Array(256);
  const size = new Uint8Array(256);
  let value = 0;
  let k = 0;
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < (spec.counts[length - 1] ?? 0); i++) {
      const symbol = spec.symbols[k++] ?? 0;
      code[symbol] = value++;
      size[symbol] = length;
    }
    value <<= 1;
  }
  return { code, size };
}

function scaledTable(base: number[], quality: number): Uint8Array {
  const q = Math.max(1, Math.min(100, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - q * 2;
  return Uint8Array.from(base.map((v) => Math.max(1, Math.min(255, Math.floor((v * scale + 50) / 100)))));
}

const COS = Float64Array.from({ length: 64 }, (_, i) => Math.cos(((2 * (i >> 3) + 1) * (i & 7) * Math.PI) / 16));

/** Forward DCT of one 8×8 block (level-shifted samples), quantized, in zigzag order. */
function transform(block: Float64Array, table: Uint8Array, out: Int32Array): void {
  for (let k = 0; k < 64; k++) {
    const u = ZIGZAG[k] ?? 0;
    const v = u >> 3;
    const h = u & 7;
    let sum = 0;
    for (let y = 0; y < 8; y++) {
      const cy = COS[y * 8 + v] ?? 0;
      for (let x = 0; x < 8; x++) sum += (block[y * 8 + x] ?? 0) * (COS[x * 8 + h] ?? 0) * cy;
    }
    const cu = v === 0 ? Math.SQRT1_2 : 1;
    const cv = h === 0 ? Math.SQRT1_2 : 1;
    out[k] = Math.round((0.25 * cu * cv * sum) / (table[u] ?? 1));
  }
}

/** MSB-first bit writer with JPEG byte stuffing. */
class BitWriter {
  bytes: number[] = [];
  private buffer = 0;
  private count = 0;

  write(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) {
      this.buffer = (this.buffer << 1) | ((value >> i) & 1);
      if (++this.count === 8) this.flushByte();
    }
  }

  private flushByte(): void {
    this.bytes.push(this.buffer);
    if (this.buffer === 0xff) this.bytes.push(0);
    this.buffer = 0;
    this.count = 0;
  }

  finish(): void {
    while (this.count !== 0) this.write(1, 1);
  }
}

function marker(out: number[], code: number, payload: number[]): void {
  out.push(0xff, code, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload);
}

function headers(width: number, height: number, luma: Uint8Array, chroma: Uint8Array): number[] {
  const out = [0xff, 0xd8];
  marker(out, 0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  marker(out, 0xdb, [0, ...Array.from(ZIGZAG, (u) => luma[u] ?? 1), 1, ...Array.from(ZIGZAG, (u) => chroma[u] ?? 1)]);
  const components = [1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1];
  marker(out, 0xc0, [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, ...components]);
  const tables: [number, HuffmanSpec][] = [
    [0x00, DC_LUMA],
    [0x10, AC_LUMA],
    [0x01, DC_CHROMA],
    [0x11, AC_CHROMA],
  ];
  for (const [id, spec] of tables) marker(out, 0xc4, [id, ...spec.counts, ...spec.symbols]);
  marker(out, 0xda, [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]);
  return out;
}

/** Number of bits of a coefficient magnitude, and its JPEG representation. */
function category(value: number): [number, number] {
  const magnitude = Math.abs(value);
  let bits = 0;
  while (magnitude >> bits) bits++;
  return [bits, value < 0 ? value + (1 << bits) - 1 : value];
}

interface Codes {
  code: Uint16Array;
  size: Uint8Array;
}

function writeBlock(writer: BitWriter, coefficients: Int32Array, previousDc: number, dc: Codes, ac: Codes): void {
  const [dcBits, dcValue] = category((coefficients[0] ?? 0) - previousDc);
  writer.write(dc.code[dcBits] ?? 0, dc.size[dcBits] ?? 0);
  writer.write(dcValue, dcBits);
  let zeros = 0;
  for (let k = 1; k < 64; k++) {
    const value = coefficients[k] ?? 0;
    if (value === 0) {
      zeros++;
      continue;
    }
    while (zeros > 15) {
      writer.write(ac.code[0xf0] ?? 0, ac.size[0xf0] ?? 0);
      zeros -= 16;
    }
    const [bits, repr] = category(value);
    const symbol = (zeros << 4) | bits;
    writer.write(ac.code[symbol] ?? 0, ac.size[symbol] ?? 0);
    writer.write(repr, bits);
    zeros = 0;
  }
  if (zeros > 0) writer.write(ac.code[0] ?? 0, ac.size[0] ?? 0);
}

/** Converts the 8×8 block at (bx, by) of RGB pixels to level-shifted Y, Cb and Cr blocks (edges replicated). */
function sampleBlock(
  rgb: Uint8Array,
  width: number,
  height: number,
  bx: number,
  by: number,
  out: Float64Array[],
): void {
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const px = Math.min(width - 1, bx + x);
      const py = Math.min(height - 1, by + y);
      const at = (py * width + px) * 3;
      const r = rgb[at] ?? 0;
      const g = rgb[at + 1] ?? 0;
      const b = rgb[at + 2] ?? 0;
      const i = y * 8 + x;
      (out[0] as Float64Array)[i] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
      (out[1] as Float64Array)[i] = -0.168736 * r - 0.331264 * g + 0.5 * b;
      (out[2] as Float64Array)[i] = 0.5 * r - 0.418688 * g - 0.081312 * b;
    }
  }
}

/** Encodes 8-bit RGB pixels as a baseline JPEG at `quality` (1–100). */
export function encodeJpeg(rgb: Uint8Array, width: number, height: number, quality: number): Uint8Array {
  const luma = scaledTable(LUMA_Q, quality);
  const chroma = scaledTable(CHROMA_Q, quality);
  const lumaCodes = { table: luma, dc: buildCodes(DC_LUMA), ac: buildCodes(AC_LUMA) };
  const chromaCodes = { table: chroma, dc: buildCodes(DC_CHROMA), ac: buildCodes(AC_CHROMA) };
  const components = [lumaCodes, chromaCodes, chromaCodes];
  const writer = new BitWriter();
  const blocks = [new Float64Array(64), new Float64Array(64), new Float64Array(64)];
  const coefficients = new Int32Array(64);
  const previous = [0, 0, 0];
  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      sampleBlock(rgb, width, height, bx, by, blocks);
      components.forEach((component, c) => {
        transform(blocks[c] as Float64Array, component.table, coefficients);
        writeBlock(writer, coefficients, previous[c] ?? 0, component.dc, component.ac);
        previous[c] = coefficients[0] ?? 0;
      });
    }
  }
  writer.finish();
  return Uint8Array.from([...headers(width, height, luma, chroma), ...writer.bytes, 0xff, 0xd9]);
}
