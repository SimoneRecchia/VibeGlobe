// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** TIFF LZW decoding (TIFF 6.0 section 13: MSB-first codes, 9–12 bits, early change), shared with `@vibeglobe/tools`. */

const CLEAR = 256;
const END = 257;

/** The string table: each code is a prefix code plus one suffix byte. */
class LzwTable {
  readonly prefix = new Int32Array(4096);
  readonly suffix = new Uint8Array(4096);
  readonly length = new Int32Array(4096);
  next = 258;

  constructor() {
    for (let i = 0; i < 256; i++) {
      this.prefix[i] = -1;
      this.suffix[i] = i;
      this.length[i] = 1;
    }
  }

  add(previous: number, first: number): void {
    this.prefix[this.next] = previous;
    this.suffix[this.next] = first;
    this.length[this.next] = (this.length[previous] ?? 0) + 1;
    this.next++;
  }

  /** Writes the string of `code` at `at` (clipped to `out`), returns its length. */
  write(code: number, out: Uint8Array, at: number): number {
    const len = this.length[code] ?? 0;
    let c = code;
    for (let i = at + len - 1; i >= at; i--) {
      if (i < out.length) out[i] = this.suffix[c] ?? 0;
      c = this.prefix[c] ?? -1;
    }
    return len;
  }
}

function readCode(input: Uint8Array, bitPos: number, width: number): number {
  let code = 0;
  for (let i = 0; i < width; i++) {
    const bit = ((input[(bitPos + i) >> 3] ?? 0) >> (7 - ((bitPos + i) & 7))) & 1;
    code = (code << 1) | bit;
  }
  return code;
}

/** Decodes one LZW-compressed strip or tile into `expectedBytes` bytes. */
export function decodeLzw(input: Uint8Array, expectedBytes: number): Uint8Array {
  const out = new Uint8Array(expectedBytes);
  let table = new LzwTable();
  let width = 9;
  let bitPos = 0;
  let written = 0;
  let previous = -1;
  while (bitPos + width <= input.length * 8 && written < expectedBytes) {
    const code = readCode(input, bitPos, width);
    bitPos += width;
    if (code === END) break;
    if (code === CLEAR) {
      table = new LzwTable();
      width = 9;
      previous = -1;
      continue;
    }
    const start = written;
    if (previous === -1 || code < table.next) {
      written += table.write(code, out, written);
      if (previous !== -1) table.add(previous, out[start] ?? 0);
    } else {
      // The KwKwK case: the new code is the previous string plus its own first byte.
      written += table.write(previous, out, written);
      const first = out[start] ?? 0;
      if (written < expectedBytes) out[written] = first;
      written++;
      table.add(previous, first);
    }
    previous = code;
    if (table.next + 1 >= 1 << width && width < 12) width++;
  }
  return out;
}
