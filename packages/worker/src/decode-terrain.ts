/**
 * The `decode-terrain` task (F134, ADR 0006 §5): a terrain tile's bytes in, a height grid out, with its heights in a
 * transferred `Float32Array`. Heightmaps are decoded by the browser's image decoder without color conversion, so the
 * bytes are the file's own; quantized-mesh tiles are rasterized to the grid. Geoid heights become ellipsoidal ones
 * here, before the grid size is chosen (F133). Gzip-compressed bytes (a server that sends `.terrain` files compressed
 * without `Content-Encoding`) are inflated first (F127).
 */
import {
  chooseGrid,
  decodeHeightmap,
  decodeQuantizedMesh,
  rasterizeQuantizedMesh,
  type HeightGrid,
} from '@vibeglobe/core';
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
type DecodedTerrain = HeightGrid & { readonly errorMeters: number; readonly metadata?: unknown };

const DECODE_OPTIONS: ImageBitmapOptions = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' };

/** True for bytes that start with the gzip magic number. */
function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Inflates gzip bytes with the platform's DecompressionStream. */
async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof DecompressionStream !== 'function')
    throw new TaskError('unsupported', 'DecompressionStream is needed for gzip-compressed terrain');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  try {
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (error) {
    throw new TaskError('undecodable', `gzip-compressed terrain could not be inflated: ${String(error)}`);
  }
}

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
  if (width !== height) throw new TaskError('undecodable', `heightmap is ${width} × ${height}, not square`);
  const context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  if (!context) throw new TaskError('unsupported', 'no 2D context for heightmaps');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const data = context.getImageData(0, 0, width, height, { colorSpace: 'srgb' }).data;
  return { rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), sizePx: width };
}

/** Decodes a terrain tile; fails with `undecodable` for bytes that are not a valid tile of their encoding. */
export async function decodeTerrain(input: unknown, context: TaskContext): Promise<TaskOutput> {
  const { bytes, encoding, maxErrorMeters, meshCells } = parseInput(input);
  let grid: DecodedTerrain;
  try {
    if (encoding === 'quantized-mesh') {
      let raw: Uint8Array<ArrayBuffer> = new Uint8Array(bytes);
      if (isGzip(raw)) raw = await gunzip(raw);
      const mesh = decodeQuantizedMesh(raw);
      grid = {
        ...rasterizeQuantizedMesh(mesh, meshCells),
        errorMeters: 0,
        ...(mesh.metadata === undefined ? {} : { metadata: mesh.metadata }),
      };
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
