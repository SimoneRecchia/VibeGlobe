// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The `decode-image` task (ADR 0011 rule 4, ADR 0010 §6): encoded image bytes in, a transferable `ImageBitmap` out,
 * decoded with fixed options so neither renderer backend converts anything at upload. A tile across its source's
 * border is masked to the source's area, and a tile of the source's blank color is answered as no data (F618).
 */
import { TaskError, type TaskContext, type TaskOutput } from './protocol.js';

/** Input of `decode-image`: encoded bytes (transferred to the worker) and their declared content type. */
export interface DecodeImageInput {
  readonly bytes: ArrayBuffer;
  /** MIME type from the response, for example `image/png`; may be empty when the server sent none. */
  readonly contentType: string;
  /** The source's area over the tile, in tile units (core's `TileMask`): pixels outside it become transparent. */
  readonly mask?: { readonly points: Float64Array; readonly ringEnds: Uint32Array };
  /** A color that, filling the whole tile, means no data: the task then fails with `no-data`. */
  readonly blank?: { readonly rgb: readonly number[]; readonly tolerance: number };
}

/** Output of `decode-image`; its shape is core's `DecodedTile`, with the bitmap transferred. */
export interface DecodedImage {
  readonly image: ImageBitmap;
  readonly widthPx: number;
  readonly heightPx: number;
  /** Bytes of the texture on the GPU as RGBA8 with a full mip chain, from {@link rgba8MipChainBytes}. */
  readonly gpuBytes: number;
}

/**
 * No orientation change beyond the file's own, no premultiplication and no color-space conversion: textures use
 * `flipY = false`, `premultiplyAlpha = false` and declare sRGB themselves (ADR 0010 §6).
 */
const DECODE_OPTIONS: ImageBitmapOptions = {
  imageOrientation: 'from-image',
  premultiplyAlpha: 'none',
  colorSpaceConversion: 'none',
};

const BYTES_PER_TEXEL_RGBA8 = 4;

/**
 * Exact bytes of an RGBA8 texture of `widthPx` × `heightPx` with every mip level down to 1 × 1: the sum of the level
 * sizes, each level halving both dimensions (rounded down, at least 1).
 */
export function rgba8MipChainBytes(widthPx: number, heightPx: number): number {
  let width = Math.max(1, Math.floor(widthPx));
  let height = Math.max(1, Math.floor(heightPx));
  let total = width * height * BYTES_PER_TEXEL_RGBA8;
  while (width > 1 || height > 1) {
    width = width > 1 ? Math.floor(width / 2) : 1;
    height = height > 1 ? Math.floor(height / 2) : 1;
    total += width * height * BYTES_PER_TEXEL_RGBA8;
  }
  return total;
}

function parseInput(input: unknown): DecodeImageInput {
  if (typeof input !== 'object' || input === null) throw new TaskError('invalid-input', 'decode-image needs an object');
  const { bytes, contentType, mask, blank } = input as Partial<Record<keyof DecodeImageInput, unknown>>;
  if (!(bytes instanceof ArrayBuffer)) throw new TaskError('invalid-input', 'decode-image needs `bytes` (ArrayBuffer)');
  if (typeof contentType !== 'string')
    throw new TaskError('invalid-input', 'decode-image needs `contentType` (string)');
  const m = mask as DecodeImageInput['mask'] | undefined;
  if (m !== undefined && !(m.points instanceof Float64Array && m.ringEnds instanceof Uint32Array))
    throw new TaskError('invalid-input', 'decode-image needs `mask.points` (Float64Array) and `mask.ringEnds`');
  const b = blank as DecodeImageInput['blank'] | undefined;
  if (b !== undefined && !(Array.isArray(b.rgb) && b.rgb.length === 3 && typeof b.tolerance === 'number'))
    throw new TaskError('invalid-input', 'decode-image needs `blank.rgb` (three numbers) and `blank.tolerance`');
  return { bytes, contentType, ...(m ? { mask: m } : {}), ...(b ? { blank: b } : {}) };
}

/** True when every pixel is opaque and within `tolerance` of the color in each channel. */
export function isBlank(rgba: Uint8ClampedArray, blank: NonNullable<DecodeImageInput['blank']>): boolean {
  const [r = 0, g = 0, b = 0] = blank.rgb;
  const t = blank.tolerance;
  for (let i = 0; i < rgba.length; i += 4) {
    if (
      Math.abs((rgba[i] ?? 0) - r) > t ||
      Math.abs((rgba[i + 1] ?? 0) - g) > t ||
      Math.abs((rgba[i + 2] ?? 0) - b) > t ||
      (rgba[i + 3] ?? 0) < 255
    )
      return false;
  }
  return true;
}

/**
 * Applies the blank test and the area mask to a decoded tile on an `OffscreenCanvas`; returns the masked bitmap (the
 * input is closed) or throws `no-data` for a blank tile.
 */
function maskTile(image: ImageBitmap, input: DecodeImageInput): ImageBitmap {
  if (typeof OffscreenCanvas !== 'function') return image;
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext('2d', { willReadFrequently: input.blank !== undefined });
  if (!context) return image;
  context.drawImage(image, 0, 0);
  if (input.blank && isBlank(context.getImageData(0, 0, image.width, image.height).data, input.blank)) {
    image.close();
    throw new TaskError('no-data', 'the tile has only the source\'s blank color');
  }
  if (!input.mask) return image;
  // Keep only what lies inside the area's rings (even-odd: holes and several polygons).
  context.globalCompositeOperation = 'destination-in';
  context.beginPath();
  const { points, ringEnds } = input.mask;
  let start = 0;
  for (const end of ringEnds) {
    for (let i = start; i < end; i++) {
      const x = (points[i * 2] ?? 0) * image.width;
      const y = (points[i * 2 + 1] ?? 0) * image.height;
      if (i === start) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.closePath();
    start = end;
  }
  context.fill('evenodd');
  image.close();
  return canvas.transferToImageBitmap();
}

function cancelledError(): TaskError {
  return new TaskError('cancelled', 'decode-image was cancelled');
}

/**
 * Decodes encoded image bytes into an `ImageBitmap`. Fails with `invalid-input` for a malformed input, `unsupported`
 * where `createImageBitmap` does not exist, `undecodable` for bytes the browser cannot decode, and `cancelled` when
 * cancelled before or right after decoding (the bitmap is then closed).
 */
export async function decodeImage(input: unknown, context: TaskContext): Promise<TaskOutput> {
  const parsed = parseInput(input);
  const { bytes, contentType } = parsed;
  if (typeof createImageBitmap !== 'function')
    throw new TaskError('unsupported', 'createImageBitmap is not available in this context');
  if (context.isCancelled()) throw cancelledError();
  let image: ImageBitmap;
  try {
    image = await createImageBitmap(new Blob([bytes], { type: contentType }), DECODE_OPTIONS);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const type = contentType === '' ? 'no content type' : contentType;
    throw new TaskError('undecodable', `${bytes.byteLength} bytes (${type}) could not be decoded: ${reason}`);
  }
  if (context.isCancelled()) {
    image.close();
    throw cancelledError();
  }
  if (parsed.mask || parsed.blank) image = maskTile(image, parsed);
  const output: DecodedImage = {
    image,
    widthPx: image.width,
    heightPx: image.height,
    gpuBytes: rgba8MipChainBytes(image.width, image.height),
  };
  return { output, transfer: [image] };
}
