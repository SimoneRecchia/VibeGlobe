// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The `decode-image` task (ADR 0011 rule 4, ADR 0010 §6): encoded image bytes in, a transferable `ImageBitmap` out,
 * decoded with fixed options so neither renderer backend converts anything at upload. A tile across its source's
 * border is masked to the source's area, and a tile of the source's blank color is answered as no data (F618).
 */
import { rgba8Bytes } from '@vibeglobe/core/decoders';
import { maskTile, type RgbaTile } from '@vibeglobe/sources/tile-mask';
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
  /** The bitmap, or the pixels of a tile masked per pixel (straight alpha, F636). */
  readonly image: ImageBitmap | RgbaTile;
  readonly widthPx: number;
  readonly heightPx: number;
  /** Bytes of the texture on the GPU as RGBA8 with a full mip chain. */
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

function parseInput(input: unknown): DecodeImageInput {
  if (typeof input !== 'object' || input === null) throw new TaskError('invalid-input', 'decode-image needs an object');
  const { bytes, contentType } = input as Partial<Record<keyof DecodeImageInput, unknown>>;
  if (!(bytes instanceof ArrayBuffer)) throw new TaskError('invalid-input', 'decode-image needs `bytes` (ArrayBuffer)');
  if (typeof contentType !== 'string')
    throw new TaskError('invalid-input', 'decode-image needs `contentType` (string)');
  // `mask` and `blank` come from the engine, not from the tile's bytes.
  return input as DecodeImageInput;
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
  let image: ImageBitmap | RgbaTile;
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
  if (parsed.mask || parsed.blank) {
    const masked = maskTile(image as ImageBitmap, parsed.blank, parsed.mask);
    if (!masked) throw new TaskError('no-data', 'a blank tile');
    image = masked;
  }
  const output: DecodedImage = {
    image,
    widthPx: image.width,
    heightPx: image.height,
    gpuBytes: rgba8Bytes(image.width, image.height),
  };
  return { output, transfer: ['data' in image ? image.data.buffer : image] };
}
