// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The `decode-terrain` task (F134, ADR 0006 §5): a terrain tile's bytes in, a height grid out, with its heights in a
 * transferred `Float32Array`. Heightmaps are decoded by the browser's image decoder without color conversion, so the
 * bytes are the file's own; quantized-mesh tiles are rasterized to the grid by a module loaded with the first one
 * (`mesh-terrain.ts`, KB-295).
 */
import { chooseGrid, decodeHeightmap, type HeightGrid } from '@vibeglobe/core/decoders';
import { TaskError, type TaskContext, type TaskOutput } from './protocol.js';

/** Input of `decode-terrain`. */
interface DecodeTerrainInput {
  readonly bytes: ArrayBuffer;
  readonly encoding: 'terrarium' | 'terrain-rgb' | 'quantized-mesh';
  /** The largest error the chosen grid may add to the source's heights, in meters. */
  readonly maxErrorMeters: number;
  /** Cells per side for quantized-mesh tiles, which carry no pixel grid of their own. */
  readonly meshCells: number;
}

/** Output of `decode-terrain`: a {@link HeightGrid} whose heights are transferred. */
export type DecodedTerrain = HeightGrid & { readonly errorMeters: number; readonly metadata?: unknown };

const DECODE_OPTIONS: ImageBitmapOptions = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' };

function parseInput(input: unknown): DecodeTerrainInput {
  if (typeof input !== 'object' || input === null)
    throw new TaskError('invalid-input', 'decode-terrain needs an object');
  const { bytes, encoding, maxErrorMeters, meshCells } = input as Partial<Record<keyof DecodeTerrainInput, unknown>>;
  if (!(bytes instanceof ArrayBuffer)) throw new TaskError('invalid-input', 'decode-terrain needs `bytes`');
  if (encoding !== 'terrarium' && encoding !== 'terrain-rgb' && encoding !== 'quantized-mesh')
    throw new TaskError('invalid-input', 'decode-terrain needs a known `encoding`');
  if (typeof maxErrorMeters !== 'number' || typeof meshCells !== 'number')
    throw new TaskError('invalid-input', 'decode-terrain needs `maxErrorMeters` and `meshCells`');
  return { bytes, encoding, maxErrorMeters, meshCells };
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
  const context =
    width === height ? new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true }) : null;
  if (context) context.drawImage(bitmap, 0, 0);
  // Closed on every path: a rejected tile's bitmap would otherwise wait for collection in the worker.
  bitmap.close();
  if (width !== height) throw new TaskError('undecodable', `heightmap is ${width} × ${height}, not square`);
  if (!context) throw new TaskError('unsupported', 'no 2D context for heightmaps');
  const data = context.getImageData(0, 0, width, height, { colorSpace: 'srgb' }).data;
  return { rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), sizePx: width };
}

/** Decodes a terrain tile; fails with `undecodable` for bytes that are not a valid tile of their encoding. */
export async function decodeTerrain(input: unknown, context: TaskContext): Promise<TaskOutput> {
  const { bytes, encoding, maxErrorMeters, meshCells } = parseInput(input);
  let grid: DecodedTerrain;
  try {
    if (encoding === 'quantized-mesh') {
      // A failed import replaces the worker, as for any task module (TG-04).
      const { meshGrid } = await import('./mesh-terrain.js').catch((error: unknown) => {
        throw new TaskError('module-unavailable', String(error));
      });
      grid = await meshGrid(bytes, meshCells, maxErrorMeters);
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
  if (context.isCancelled()) throw new TaskError('cancelled', 'decode-terrain was cancelled');
  // Core's DecodedTile: a float32 texture of the grid's vertices, without mipmaps.
  const side = grid.cells + 1;
  const output = { widthPx: side, heightPx: side, gpuBytes: side * side * 4, image: grid };
  return { output, transfer: [grid.heightsMeters.buffer] };
}
