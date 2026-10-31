// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { archiveTransport, HttpStatusError, NetworkError, tileOfUrl } from './archive-transport.js';
import {
  type Attribution,
  CUSTOM_PROFILE,
  type DescribedImagerySource,
  type ProviderProfile,
  SourceConfigError,
} from './metadata.js';
import { downloadImage } from './single-image.js';
import { xyzImagery } from './xyz-imagery.js';

/**
 * Cuts one tile out of a decoded Web Mercator image: its level, its column and its row from the north, and its size;
 * resolves the tile encoded as an image.
 */
export type CutTile = (
  level: number,
  x: number,
  y: number,
  sizePx: number,
) => Promise<{ readonly bytes: ArrayBuffer; readonly contentType: string }>;

/** Options of {@link mercatorImage}. */
export interface MercatorImageOptions {
  /** Unique per engine instance. */
  readonly id: string;
  /**
   * A PNG, JPEG or WebP image of the whole Web Mercator square (180° W to 180° E, about 85.05° S to 85.05° N): a URL,
   * downloaded with the first tile, or a local `File` or `Blob`.
   */
  readonly image: string | Blob;
  /** The finest level, 0 to 22: levels 0 to `maxLevel` are cut from the image, and the engine enlarges finer ones. */
  readonly maxLevel: number;
  /** The tiles' size, pixels (default 256). */
  readonly tileSizePx?: number;
  readonly attribution?: readonly Attribution[];
  readonly profile?: ProviderProfile;
  readonly fetch?: typeof fetch;
  /** Time limit of the download (default 120 s). */
  readonly downloadTimeoutMs?: number;
  /** Decodes the image once and returns how to cut its tiles; replaces the browser's (tests, other runtimes). */
  readonly decodeImage?: (image: Blob) => Promise<CutTile>;
}

const MAX_LEVEL = 22;

/** Decodes with `createImageBitmap`; each tile draws its share of the image on an `OffscreenCanvas`, encoded as PNG. */
async function decodeInBrowser(image: Blob): Promise<CutTile> {
  const bitmap = await createImageBitmap(image);
  return async (level, x, y, sizePx) => {
    const canvas = new OffscreenCanvas(sizePx, sizePx);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2D context');
    context.imageSmoothingQuality = 'high';
    const widthPx = bitmap.width / 2 ** level;
    const heightPx = bitmap.height / 2 ** level;
    context.drawImage(bitmap, x * widthPx, y * heightPx, widthPx, heightPx, 0, 0, sizePx, sizePx);
    const blob = await canvas.convertToBlob();
    return { bytes: await blob.arrayBuffer(), contentType: blob.type };
  };
}

/** The image as a `Blob`; a download that fails without an HTTP status is a network error, retried by the engine. */
function imageOf(options: MercatorImageOptions): Promise<Blob> {
  if (typeof options.image !== 'string') return Promise.resolve(options.image);
  return downloadImage(options).then(
    (bytes) => new Blob([bytes]),
    (error: unknown) => {
      throw error instanceof HttpStatusError ? error : new NetworkError(error);
    },
  );
}

/**
 * One Web Mercator image of the whole world as an imagery source (F650), for an image too coarse to be worth a folder
 * of tiles, such as night lights shown from afar. The image is downloaded with the first tile and decoded once; each
 * tile of levels 0 to `maxLevel` is cut from it on request. A failed download is tried again with the next tile, and
 * tiles fail as downloaded ones do: an HTTP status, a network error, a timeout, aborted; an image that cannot be
 * decoded is no data. An invalid `maxLevel` throws a {@link SourceConfigError}.
 */
export function mercatorImage(options: MercatorImageOptions): DescribedImagerySource {
  const { id, maxLevel } = options;
  if (!Number.isInteger(maxLevel) || maxLevel < 0 || maxLevel > MAX_LEVEL)
    throw new SourceConfigError(
      'invalid-option',
      `Web Mercator image '${id}': maxLevel must be an integer from 0 to ${MAX_LEVEL}`,
    );
  const decode = options.decodeImage ?? decodeInBrowser;
  const sizePx = options.tileSizePx ?? 256;
  let decoded: Promise<CutTile> | undefined;
  const cutter = (): Promise<CutTile> => {
    if (decoded) return decoded;
    const image = imageOf(options);
    const current = image.then(decode);
    decoded = current;
    image.catch(() => {
      if (decoded === current) decoded = undefined;
    });
    return current;
  };
  const source = xyzImagery({
    id,
    url: `mercator-image:${encodeURIComponent(id)}/{z}/{x}/{y}`,
    maxLevel,
    tileSizePx: sizePx,
    transport: archiveTransport(async (url, signal) => {
      const tile = tileOfUrl(url);
      const cut = tile && (await cutter());
      // A request aborted meanwhile has already ended: its tile is not cut.
      return cut && !signal.aborted ? cut(tile.z, tile.x, tile.y, sizePx) : undefined;
    }),
    ...(options.attribution ? { attribution: options.attribution } : {}),
  });
  return {
    ...source,
    attribution: options.attribution ?? [],
    profile: options.profile ?? CUSTOM_PROFILE,
    transportRequired: true,
  };
}
