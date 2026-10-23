/**
 * @packageDocumentation
 * GeoTIFF images as single georeferenced images (F234), in their own entry point because they bring a GeoTIFF decoder
 * (`geotiff`) with them.
 * @module @vibeglobe/sources/geotiff
 */
import { SourceConfigError, type DescribedImagerySource } from './metadata.js';
import { encodeRgbaPng } from './reproject/edge-bleed.js';
import { downloadImage, singleImage, type SingleImageOptions } from './single-image.js';

/** Options of {@link geotiffImage}: those of a single image, with the placement read from the GeoTIFF's tags. */
export interface GeotiffImageOptions extends Omit<
  SingleImageOptions,
  'image' | 'bounds' | 'worldFile' | 'crs' | 'sizePx'
> {
  /** The GeoTIFF: a URL (downloaded once) or a local `File` or `Blob`. */
  readonly image: string | Blob;
}

/** The georeference of a GeoTIFF: its reference system, box and size. */
export interface GeotiffGeoreference {
  readonly crs: string;
  readonly bounds: [number, number, number, number];
  readonly sizePx: [number, number];
}

const MAX_SIDE_PX = 32_768;

/**
 * Reads a GeoTIFF's georeference (ModelTiepoint and ModelPixelScale, the EPSG code of its GeoKeys) and its pixels as
 * RGBA. Rejects with a {@link SourceConfigError} for anything it cannot place or decode; it never throws another error.
 */
export async function readGeotiff(
  bytes: ArrayBuffer,
  id = 'geotiff',
): Promise<GeotiffGeoreference & { readonly rgba: Uint8ClampedArray }> {
  try {
    const { fromArrayBuffer } = await import('geotiff');
    const tiff = await fromArrayBuffer(bytes);
    const image = await tiff.getImage();
    const widthPx = image.getWidth();
    const heightPx = image.getHeight();
    if (!(widthPx > 0 && heightPx > 0 && widthPx <= MAX_SIDE_PX && heightPx <= MAX_SIDE_PX))
      throw new Error(`unsupported size ${String(widthPx)} × ${String(heightPx)}`);
    const keys = (image.getGeoKeys() ?? {}) as Record<string, unknown>;
    const code = Number(keys['ProjectedCSTypeGeoKey'] ?? keys['GeographicTypeGeoKey']);
    if (!Number.isInteger(code) || code <= 0 || code === 32767) throw new Error('no EPSG code in its GeoKeys');
    const [w = NaN, s = NaN, e = NaN, n = NaN] = image.getBoundingBox();
    if (![w, s, e, n].every(Number.isFinite) || w >= e || s >= n)
      throw new Error('no usable tie point and pixel scale');
    const rgb = (await image.readRGB({ interleave: true, enableAlpha: true })) as unknown as ArrayLike<number> & {
      length: number;
    };
    const channels = rgb.length / (widthPx * heightPx);
    if (channels !== 3 && channels !== 4) throw new Error(`unsupported ${String(channels)}-channel raster`);
    const rgba = new Uint8ClampedArray(widthPx * heightPx * 4);
    for (let p = 0, q = 0; p < rgba.length; p += 4, q += channels) {
      rgba[p] = rgb[q] ?? 0;
      rgba[p + 1] = rgb[q + 1] ?? 0;
      rgba[p + 2] = rgb[q + 2] ?? 0;
      rgba[p + 3] = channels === 4 ? (rgb[q + 3] ?? 255) : 255;
    }
    return { crs: `EPSG:${String(code)}`, bounds: [w, s, e, n], sizePx: [widthPx, heightPx], rgba };
  } catch (error) {
    throw new SourceConfigError(
      'unreadable-geotiff',
      `GeoTIFF '${id}': cannot read it (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/**
 * A GeoTIFF shown as a single georeferenced image (F234): placed by its own tags, reprojected on the client when its
 * system is neither EPSG:4326 nor EPSG:3857 (`transforms`), split into engine tiles whatever its size.
 */
export async function geotiffImage(options: GeotiffImageOptions): Promise<DescribedImagerySource> {
  let bytes: ArrayBuffer;
  try {
    bytes = await downloadImage(options);
  } catch (error) {
    throw new SourceConfigError('unreachable-image', `GeoTIFF '${options.id}': cannot load it (${String(error)})`);
  }
  const tiff = await readGeotiff(bytes, options.id);
  const png = await encodeRgbaPng(tiff.rgba, tiff.sizePx[0], tiff.sizePx[1]);
  return singleImage({
    ...options,
    image: new Blob([png], { type: 'image/png' }),
    crs: tiff.crs,
    bounds: tiff.bounds,
    sizePx: tiff.sizePx,
  });
}
