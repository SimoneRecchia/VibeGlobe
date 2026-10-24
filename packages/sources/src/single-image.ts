// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { AbortHandle, TileRequest, TimeoutsMs, TransportResult } from '@vibeglobe/core';
import { HttpStatusError, NetworkError } from './archive-transport.js';
import { retryAfterMs } from './fetch-transport.js';
import {
  type Attribution,
  CUSTOM_PROFILE,
  type DescribedImagerySource,
  type ProviderProfile,
  SourceConfigError,
} from './metadata.js';
import { encodeRgbaPng } from './reproject/edge-bleed.js';
import {
  type ComposeImage,
  type FetchedPart,
  reprojectedImagery,
  type WarpImage,
} from './reproject/reprojected-imagery.js';
import type { FromSource, SourceBbox, ToSource } from './reproject/warp-math.js';

/** Options of {@link singleImage}. */
export interface SingleImageOptions {
  /** Unique per engine instance. */
  readonly id: string;
  /** A PNG, JPEG or WebP image: a URL (downloaded once) or a local `File` or `Blob`. */
  readonly image: string | Blob;
  /** The reference system of `bounds` or of the world file (default 'EPSG:4326'). */
  readonly crs?: string;
  /** Where the image lies: west, south, east, north edges in the units of `crs` (degrees for EPSG:4326). */
  readonly bounds?: SourceBbox;
  /** The text of an ESRI world file (`.pgw`, `.jgw`, `.wld`), instead of `bounds`. */
  readonly worldFile?: string;
  /** The image's size, pixels; read from the image's header when omitted. */
  readonly sizePx?: readonly [widthPx: number, heightPx: number];
  /**
   * Transforms for systems other than EPSG:4326 and EPSG:3857, such as `transformCoordinates` of `@vibeglobe/gis`; the
   * image is reprojected on the client (ADR 0039).
   */
  readonly transforms?: (crs: string) => { readonly toSource: ToSource; readonly fromSource: FromSource } | undefined;
  readonly attribution?: readonly Attribution[];
  readonly profile?: ProviderProfile;
  /** The finest engine level; by default one level finer than the image's own resolution. */
  readonly maxLevel?: number;
  readonly fetch?: typeof fetch;
  /** Time limit of the download (default 120 s). */
  readonly downloadTimeoutMs?: number;
  /** Replace the browser warp and composition (tests, other runtimes). */
  readonly warpImage?: WarpImage;
  readonly composeImage?: ComposeImage;
}

/** An ESRI world file: pixel size along x and y, rotation terms, and the centre of the top-left pixel. */
export interface WorldFile {
  readonly a: number;
  readonly d: number;
  readonly b: number;
  readonly e: number;
  readonly c: number;
  readonly f: number;
}

/** Parses a world file's six lines (A, D, B, E, C, F); undefined unless they are six finite numbers. */
export function parseWorldFile(text: string): WorldFile | undefined {
  const values = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (values.length !== 6 || !values.every((v) => /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(v))) return undefined;
  const [a = NaN, d = NaN, b = NaN, e = NaN, c = NaN, f = NaN] = values.map(Number);
  return [a, d, b, e, c, f].every(Number.isFinite) ? { a, d, b, e, c, f } : undefined;
}

/** The size of a PNG, JPEG or WebP image from its header; undefined for anything else or a truncated header. */
export function imageSizeOf(bytes: Uint8Array): [number, number] | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = (i: number): number => bytes[i] ?? -1;
  if (bytes.length >= 24 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47)
    return positive(view.getUint32(16), view.getUint32(20));
  if (bytes.length >= 30 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF') {
    const chunk = String.fromCharCode(...bytes.subarray(12, 16));
    if (chunk === 'VP8 ') return positive(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    if (chunk === 'VP8L') {
      const bits = view.getUint32(21, true);
      return positive((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (chunk === 'VP8X')
      return positive((at(24) | (at(25) << 8) | (at(26) << 16)) + 1, (at(27) | (at(28) << 8) | (at(29) << 16)) + 1);
    return undefined;
  }
  if (at(0) === 0xff && at(1) === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (at(i) !== 0xff) return undefined;
      const marker = at(i + 1);
      const length = view.getUint16(i + 2);
      // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
        return positive(view.getUint16(i + 7), view.getUint16(i + 5));
      if (length < 2) return undefined;
      i += 2 + length;
    }
  }
  return undefined;
}

function positive(widthPx: number, heightPx: number): [number, number] | undefined {
  return widthPx > 0 && heightPx > 0 ? [widthPx, heightPx] : undefined;
}

const MERCATOR_R = 6378137;
const DEG = Math.PI / 180;
const MAX_LAT_DEG = 85.0511287798066;

/** The built-in systems: geographic degrees and Web Mercator meters. */
function builtInTransforms(crs: string): { toSource: ToSource; fromSource: FromSource } | undefined {
  if (crs === 'EPSG:4326') return { toSource: (lon, lat) => [lon, lat], fromSource: (x, y) => [x, y] };
  if (crs === 'EPSG:3857' || crs === 'EPSG:900913')
    return {
      toSource: (lon, lat) => {
        const clamped = Math.max(-MAX_LAT_DEG, Math.min(MAX_LAT_DEG, lat));
        return [MERCATOR_R * lon * DEG, MERCATOR_R * Math.log(Math.tan(Math.PI / 4 + (clamped * DEG) / 2))];
      },
      fromSource: (x, y) => [x / MERCATOR_R / DEG, (2 * Math.atan(Math.exp(y / MERCATOR_R)) - Math.PI / 2) / DEG],
    };
  return undefined;
}

/** Downloads (or reads) the image, within its time limit. */
export async function downloadImage(
  options: Pick<SingleImageOptions, 'image' | 'fetch' | 'downloadTimeoutMs'>,
): Promise<ArrayBuffer> {
  const image = options.image;
  if (typeof image !== 'string') return image.arrayBuffer();
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.downloadTimeoutMs ?? 120_000);
  try {
    let response: Response;
    try {
      response = await fetchImpl(image, { mode: 'cors', credentials: 'omit', signal: controller.signal });
    } catch (error) {
      throw controller.signal.aborted ? new Error('the download timed out') : new NetworkError(error);
    }
    if (!response.ok)
      throw new HttpStatusError(response.status, retryAfterMs(response.headers.get('Retry-After'), Date.now()));
    return await response.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}

/** The image's box in its system from `bounds` or a world file. */
function boxOf(options: SingleImageOptions, sizePx: readonly [number, number]): SourceBbox {
  if (options.bounds) {
    const [w, s, e, n] = options.bounds;
    if (![w, s, e, n].every(Number.isFinite) || w >= e || s >= n)
      throw new SourceConfigError(
        'invalid-bounds',
        `Single image '${options.id}': bounds must be west < east, south < north`,
      );
    return options.bounds;
  }
  const world = options.worldFile === undefined ? undefined : parseWorldFile(options.worldFile);
  if (!world)
    throw new SourceConfigError(
      'missing-georeference',
      `Single image '${options.id}': give bounds or a world file of six numbers`,
    );
  if (world.b !== 0 || world.d !== 0)
    throw new SourceConfigError('rotated-image', `Single image '${options.id}': rotated world files are not supported`);
  if (world.a <= 0 || world.e >= 0)
    throw new SourceConfigError(
      'invalid-world-file',
      `Single image '${options.id}': the world file's pixel size is invalid`,
    );
  const west = world.c - world.a / 2;
  const north = world.f - world.e / 2;
  return [west, north + world.e * sizePx[1], west + world.a * sizePx[0], north];
}

/** The level at which a Web Mercator tile pixel is as fine as the image's pixels, plus one. */
function levelOf(box: SourceBbox, sizePx: readonly [number, number], fromSource: FromSource): number {
  const [w, s, e, n] = box;
  const [lon0] = fromSource(w, (s + n) / 2);
  const [lon1] = fromSource(e, (s + n) / 2);
  const degPerPx = Math.abs(lon1 - lon0) / sizePx[0] || 1e-9;
  // Web Mercator's degrees of longitude per pixel at level z are 360 / (256 · 2^z), at any latitude.
  return Math.max(0, Math.min(22, Math.ceil(Math.log2(360 / (256 * degPerPx))) + 1));
}

/**
 * Composes the single image's part per tile (F234): decoded once, then each tile draws only its piece, so images larger
 * than the GPU's texture limit reach the GPU as 256-pixel tiles.
 */
function composeOnce(): ComposeImage {
  const bitmaps = new WeakMap<ArrayBuffer, Promise<ImageBitmap>>();
  return async (parts: readonly FetchedPart[], widthPx: number, heightPx: number) => {
    const canvas = new OffscreenCanvas(widthPx, heightPx);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2D context');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    for (const part of parts) {
      let bitmap = bitmaps.get(part.bytes);
      if (!bitmap) {
        bitmap = createImageBitmap(new Blob([part.bytes], { type: part.contentType }));
        bitmaps.set(part.bytes, bitmap);
      }
      const image = await bitmap;
      // Only the piece inside the canvas: its source rectangle in image pixels.
      const scaleX = image.width / part.widthPx;
      const scaleY = image.height / part.heightPx;
      const x0 = Math.max(0, part.xPx);
      const y0 = Math.max(0, part.yPx);
      const x1 = Math.min(widthPx, part.xPx + part.widthPx);
      const y1 = Math.min(heightPx, part.yPx + part.heightPx);
      if (x1 <= x0 || y1 <= y0) continue;
      context.drawImage(
        image,
        (x0 - part.xPx) * scaleX,
        (y0 - part.yPx) * scaleY,
        (x1 - x0) * scaleX,
        (y1 - y0) * scaleY,
        x0,
        y0,
        x1 - x0,
        y1 - y0,
      );
    }
    return encodeRgbaPng(context.getImageData(0, 0, widthPx, heightPx).data, widthPx, heightPx);
  };
}

/** Serves the downloaded image's bytes for its key, always the same buffer (the composition caches its decoding). */
function imageTransport(key: string, bytes: ArrayBuffer, contentType: string) {
  return {
    start(request: TileRequest, _timeouts: TimeoutsMs, done: (result: TransportResult) => void): AbortHandle {
      let aborted = false;
      queueMicrotask(() => {
        if (aborted) return;
        done(
          request.url === key
            ? { kind: 'ok', bytes, contentType }
            : { kind: 'status', status: 404, retryAfterMs: undefined },
        );
      });
      return () => {
        if (aborted) return;
        aborted = true;
        done({ kind: 'aborted' });
      };
    },
  };
}

function contentTypeOf(bytes: Uint8Array): string {
  if (bytes[0] === 0x89) return 'image/png';
  if (bytes[0] === 0xff) return 'image/jpeg';
  return 'image/webp';
}

/**
 * A single georeferenced image (F234): a PNG, JPEG or WebP with explicit bounds or a world file, in EPSG:4326,
 * EPSG:3857, or any system `transforms` knows, shown at its exact place and reprojected on the client. The image is
 * downloaded once and decoded once; every engine tile draws its own piece. Rejects with a {@link SourceConfigError}
 * when the image cannot be read or placed.
 */
export async function singleImage(options: SingleImageOptions): Promise<DescribedImagerySource> {
  const crs = options.crs ?? 'EPSG:4326';
  const pair = builtInTransforms(crs) ?? options.transforms?.(crs);
  if (!pair)
    throw new SourceConfigError(
      'needs-reprojection',
      `Single image '${options.id}': ${crs} needs transforms (for example transformCoordinates of @vibeglobe/gis)`,
    );
  let bytes: ArrayBuffer;
  try {
    bytes = await downloadImage(options);
  } catch (error) {
    throw new SourceConfigError('unreachable-image', `Single image '${options.id}': cannot load it (${String(error)})`);
  }
  const header = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 65_536));
  const sizePx = options.sizePx ?? imageSizeOf(header);
  if (!sizePx)
    throw new SourceConfigError('unreadable-image', `Single image '${options.id}': not a PNG, JPEG or WebP image`);
  const box = boxOf(options, sizePx);
  const key = `single-image:${encodeURIComponent(options.id)}`;
  const [bw, bs, be, bn] = box;
  const source = reprojectedImagery({
    id: options.id,
    sourceCrs: crs,
    toSource: pair.toSource,
    fromSource: pair.fromSource,
    bounds: box,
    maxLevel: options.maxLevel ?? levelOf(box, sizePx, pair.fromSource),
    image: (bbox, widthPx, heightPx) => {
      const [x0, y0, x1, y1] = bbox;
      if (be <= x0 || bw >= x1 || bn <= y0 || bs >= y1) return [];
      const sx = widthPx / (x1 - x0);
      const sy = heightPx / (y1 - y0);
      return [
        { url: key, xPx: (bw - x0) * sx, yPx: (y1 - bn) * sy, widthPx: (be - bw) * sx, heightPx: (bn - bs) * sy },
      ];
    },
    transport: imageTransport(key, bytes, contentTypeOf(header)),
    composeImage: options.composeImage ?? composeOnce(),
    ...(options.warpImage ? { warpImage: options.warpImage } : {}),
  });
  return {
    ...source,
    attribution: options.attribution ?? [],
    profile: options.profile ?? CUSTOM_PROFILE,
    transportRequired: true,
  };
}
