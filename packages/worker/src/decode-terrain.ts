// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The `decode-terrain` task (F134, ADR 0006 §5): a terrain tile's bytes in, a height grid out, with its heights in a
 * transferred `Float32Array`. Heightmaps are decoded by the browser's image decoder without color conversion, so the
 * bytes are the file's own; quantized-mesh tiles are rasterized to the grid. Geoid heights become ellipsoidal ones
 * here, before the grid size is chosen (F133). Gzip-compressed bytes (a server that sends `.terrain` files compressed
 * without `Content-Encoding`) are inflated first (F127).
 */
import { chooseGrid, decodeHeightmap, type HeightGrid } from '@vibeglobe/core/decoders';
import { decodeQuantizedMesh, meshGridErrorMeters, rasterizeQuantizedMesh } from '@vibeglobe/core/decoders';
import { DECODE_OPTIONS } from './decode-image.js';
import { cancelled, inputWithBytes, TaskError, type TaskContext, type TaskOutput } from './protocol.js';

/** Input of `decode-terrain`. */
interface DecodeTerrainInput {
  readonly bytes: ArrayBuffer;
  readonly encoding: 'terrarium' | 'terrain-rgb' | 'quantized-mesh';
  /** The largest error the chosen grid may add to the source's heights, in meters. */
  readonly maxErrorMeters: number;
  /** Cells per side for quantized-mesh tiles, which carry no pixel grid of their own. */
  readonly meshCells: number;
}

/** The finest grid a quantized-mesh tile is rasterized to, as heightmaps' (`GRID_CELLS`). */
const MAX_MESH_CELLS = 256;

/** Output of `decode-terrain`: a {@link HeightGrid} whose heights are transferred. */
type DecodedTerrain = HeightGrid & { readonly errorMeters: number; readonly metadata?: unknown };

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
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  // A corrupt stream rejects a read: `decodeTerrain` reports it as `undecodable`.
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limitBytes) {
      await reader.cancel();
      throw new TaskError('undecodable', `gzip-compressed terrain inflates beyond ${limitBytes} bytes`);
    }
    chunks.push(value as Uint8Array<ArrayBuffer>);
  }
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

function parseInput(input: unknown): DecodeTerrainInput {
  const parsed = inputWithBytes('decode-terrain', input);
  const { encoding, maxErrorMeters, meshCells } = parsed;
  if (encoding !== 'terrarium' && encoding !== 'terrain-rgb' && encoding !== 'quantized-mesh')
    throw new TaskError('invalid-input', 'decode-terrain needs a known `encoding`');
  if (typeof maxErrorMeters !== 'number' || typeof meshCells !== 'number')
    throw new TaskError('invalid-input', 'decode-terrain needs `maxErrorMeters` and `meshCells`');
  return parsed as unknown as DecodeTerrainInput;
}

/** The RGBA bytes of an encoded square image. */
async function imagePixels(bytes: ArrayBuffer): Promise<{ rgba: Uint8Array; sizePx: number }> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function')
    throw new TaskError('unsupported', 'createImageBitmap and OffscreenCanvas are needed for heightmaps');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes]), DECODE_OPTIONS);
  } catch (error) {
    throw new TaskError('undecodable', `heightmap could not be decoded: ${String(error)}`);
  }
  const { width, height } = bitmap;
  try {
    if (width !== height) throw new TaskError('undecodable', `heightmap is ${width} × ${height}, not square`);
    const context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
    if (!context) throw new TaskError('unsupported', 'no 2D context for heightmaps');
    if (exactReadback === undefined) {
      context.fillRect(0, 0, 8, 8);
      exactReadback = context.getImageData(0, 0, 8, 8).data.every((value, i) => value === (i % 4 > 2 ? 255 : 0));
      context.clearRect(0, 0, 8, 8);
    }
    if (exactReadback) {
      context.drawImage(bitmap, 0, 0);
      const data = context.getImageData(0, 0, width, height).data;
      return { rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), sizePx: width };
    }
    const frame = new VideoFrame(bitmap, { timestamp: 0 });
    const bgr = frame.format?.[0] === 'B';
    const rgba = new Uint8Array(frame.allocationSize());
    await frame.copyTo(rgba).finally(() => frame.close());
    // A frame may hold the pixels as BGRA (a rare path: a view per pixel is cheap enough).
    if (bgr) for (let i = 0; i < rgba.length; i += 4) rgba.subarray(i, i + 3).reverse();
    return { rgba, sizePx: width };
  } finally {
    // Closed on every path: a rejected tile's bitmap would otherwise wait for collection in the worker.
    bitmap.close();
  }
}

/**
 * Whether a canvas reads back exactly what was drawn (a black fill), checked once. Fingerprinting protection
 * (Safari's private windows, Firefox's resistFingerprinting, Brave) adds noise to `getImageData`, which would turn
 * heights into spikes (MapLibre #3110); the pixels then come from a `VideoFrame` copy, which it leaves alone (KB-314).
 */
let exactReadback: boolean | undefined;

/** Decodes a terrain tile; fails with `undecodable` for bytes that are not a valid tile of their encoding. */
export async function decodeTerrain(input: unknown, context: TaskContext): Promise<TaskOutput> {
  const { bytes, encoding, maxErrorMeters, meshCells } = parseInput(input);
  let grid: DecodedTerrain;
  try {
    if (encoding === 'quantized-mesh') {
      let raw: Uint8Array<ArrayBuffer> = new Uint8Array(bytes);
      // The gzip magic number.
      if (raw[0] === 0x1f && raw[1] === 0x8b) raw = await gunzip(raw);
      const mesh = decodeQuantizedMesh(raw);
      // From `meshCells` up to 256 cells, the first grid within the bound of every mesh vertex (F134, ADR 0028).
      let raster = rasterizeQuantizedMesh(mesh, meshCells);
      let errorMeters = meshGridErrorMeters(mesh, raster);
      for (let cells = meshCells * 2; cells <= MAX_MESH_CELLS && errorMeters > maxErrorMeters; cells *= 2) {
        raster = rasterizeQuantizedMesh(mesh, cells);
        errorMeters = meshGridErrorMeters(mesh, raster);
      }
      grid = { ...raster, errorMeters, metadata: mesh.metadata };
    } else {
      const { rgba, sizePx } = await imagePixels(bytes);
      const pixels = decodeHeightmap(rgba, sizePx, encoding);
      const measured = chooseGrid(pixels, sizePx, maxErrorMeters);
      grid = { ...measured.grid, errorMeters: measured.maxErrorMeters };
    }
  } catch (error) {
    if (error instanceof TaskError) throw error;
    throw new TaskError('undecodable', error instanceof Error ? error.message : String(error));
  }
  if (context.isCancelled()) throw cancelled('decode-terrain');
  // Core's DecodedTile: a float32 texture of the grid's vertices, without mipmaps.
  const side = grid.cells + 1;
  const output = { widthPx: side, heightPx: side, gpuBytes: side * side * 4, image: grid };
  return { output, transfer: [grid.heightsMeters.buffer] };
}
