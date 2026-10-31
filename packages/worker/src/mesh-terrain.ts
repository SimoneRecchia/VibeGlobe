// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Quantized-mesh terrain tiles for `decode-terrain` (F134, ADR 0028), loaded with the first one, so workers that
 * decode heightmaps never load it (KB-295). Gzip-compressed bytes (a server that sends `.terrain` files compressed
 * without `Content-Encoding`) are inflated first (F127).
 */
import { decodeQuantizedMesh, meshGridErrorMeters, rasterizeQuantizedMesh } from '@vibeglobe/core/decoders';
import type { DecodedTerrain } from './decode-terrain.js';
import { TaskError } from './protocol.js';

/** The finest grid a quantized-mesh tile is rasterized to, as heightmaps' (`GRID_CELLS`). */
const MAX_MESH_CELLS = 256;

/** True for bytes that start with the gzip magic number. */
function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * The most bytes a gzip-compressed terrain tile may inflate to (F131: no unbounded allocation). Quantized-mesh tiles,
 * even with 32-bit indices and every extension, stay well below it.
 */
const MAX_INFLATED_BYTES = 32 * 1024 * 1024;

/**
 * Inflates gzip bytes with the platform's DecompressionStream, chunk by chunk, failing with `undecodable` once the
 * output passes `limitBytes` (a gzip bomb never allocates more).
 */
export async function gunzip(
  bytes: Uint8Array<ArrayBuffer>,
  limitBytes = MAX_INFLATED_BYTES,
): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof DecompressionStream !== 'function')
    throw new TaskError('unsupported', 'DecompressionStream is needed for gzip-compressed terrain');
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limitBytes) {
        await reader.cancel();
        throw new TaskError('undecodable', `gzip-compressed terrain inflates beyond ${limitBytes} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof TaskError) throw error;
    throw new TaskError('undecodable', `gzip-compressed terrain could not be inflated: ${String(error)}`);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** A quantized-mesh tile rasterized from `meshCells` up to 256 cells: the first grid within `maxErrorMeters` of every vertex. */
export async function meshGrid(bytes: ArrayBuffer, meshCells: number, maxErrorMeters: number): Promise<DecodedTerrain> {
  let raw: Uint8Array<ArrayBuffer> = new Uint8Array(bytes);
  if (isGzip(raw)) raw = await gunzip(raw);
  const mesh = decodeQuantizedMesh(raw);
  let raster = rasterizeQuantizedMesh(mesh, meshCells);
  let errorMeters = meshGridErrorMeters(mesh, raster);
  for (let cells = meshCells * 2; cells <= MAX_MESH_CELLS && errorMeters > maxErrorMeters; cells *= 2) {
    raster = rasterizeQuantizedMesh(mesh, cells);
    errorMeters = meshGridErrorMeters(mesh, raster);
  }
  return { ...raster, errorMeters, ...(mesh.metadata === undefined ? {} : { metadata: mesh.metadata }) };
}
