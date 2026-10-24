// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { check } from './errors.js';

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'
const HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;

/** The two chunks of a GLB file: the JSON text and the optional binary buffer. */
export interface GlbChunks {
  readonly json: string;
  /** The BIN chunk, a view into the input (not a copy); `undefined` when the file has none. */
  readonly bin: Uint8Array | undefined;
}

/** True when the bytes start with the GLB magic ('glTF'). */
export function isGlb(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 &&
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === GLB_MAGIC
  );
}

/**
 * Splits a GLB 2.0 file into its JSON and BIN chunks, checking the header, the declared length, chunk bounds and
 * 4-byte alignment. Throws a ModelError ('invalid-glb') for anything truncated or malformed, and ('unsupported') for
 * a container version other than 2. Unknown chunk types after the first are skipped, as the specification asks.
 */
export function parseGlb(bytes: Uint8Array): GlbChunks {
  check(bytes.byteLength >= HEADER_BYTES, 'invalid-glb', 'GLB shorter than its 12-byte header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  check(view.getUint32(0, true) === GLB_MAGIC, 'invalid-glb', 'GLB magic missing');
  const version = view.getUint32(4, true);
  check(version === 2, 'unsupported', `GLB container version ${version} (only 2 is read)`);
  const length = view.getUint32(8, true);
  check(length <= bytes.byteLength, 'invalid-glb', `GLB declares ${length} bytes but has ${bytes.byteLength}`);
  check(length % 4 === 0, 'invalid-glb', 'GLB length is not a multiple of 4');
  let offset = HEADER_BYTES;
  let json: string | undefined;
  let bin: Uint8Array | undefined;
  let index = 0;
  while (offset < length) {
    check(offset + CHUNK_HEADER_BYTES <= length, 'invalid-glb', 'GLB chunk header truncated');
    const chunkLength = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + CHUNK_HEADER_BYTES;
    check(start + chunkLength <= length, 'invalid-glb', `GLB chunk ${index} runs past the end of the file`);
    check(chunkLength % 4 === 0, 'invalid-glb', `GLB chunk ${index} length is not a multiple of 4`);
    const data = bytes.subarray(start, start + chunkLength);
    if (index === 0) {
      check(type === CHUNK_JSON, 'invalid-glb', 'the first GLB chunk is not JSON');
      json = new TextDecoder('utf-8', { fatal: false }).decode(data);
    } else if (index === 1 && type === CHUNK_BIN) bin = data;
    offset = start + chunkLength;
    index++;
  }
  check(json !== undefined, 'invalid-glb', 'GLB has no JSON chunk');
  return { json, bin };
}
