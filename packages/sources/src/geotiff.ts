// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * @packageDocumentation
 * GeoTIFF images as single georeferenced images (F234), in their own entry point with their TIFF decoder.
 * @module @vibeglobe/sources/geotiff
 */
import { SourceConfigError, type DescribedImagerySource } from './metadata.js';
import { encodeRgbaPng } from './reproject/edge-bleed.js';
import { readTiff } from './tiff/tiff-reader.js';
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

/**
 * Reads a GeoTIFF's georeference (ModelTiepoint and ModelPixelScale, the EPSG code of its GeoKeys) and its pixels as
 * RGBA. Rejects with a {@link SourceConfigError} for anything it cannot place or decode; it never throws another error.
 */
export function readGeotiff(
  bytes: ArrayBuffer,
  id = 'geotiff',
): Promise<GeotiffGeoreference & { readonly rgba: Uint8ClampedArray }> {
  try {
    const raster = readTiff(new Uint8Array(bytes));
    const { widthPx, heightPx, samplesPerPixel: channels, data } = raster;
    const rgba = new Uint8ClampedArray(widthPx * heightPx * 4);
    for (let p = 0, q = 0; p < rgba.length; p += 4, q += channels) {
      rgba[p] = data[q] ?? 0;
      rgba[p + 1] = data[q + 1] ?? 0;
      rgba[p + 2] = data[q + 2] ?? 0;
      rgba[p + 3] = channels === 4 ? (data[q + 3] ?? 255) : 255;
    }
    return Promise.resolve({ crs: raster.crs, bounds: raster.bounds, sizePx: [widthPx, heightPx], rgba });
  } catch (error) {
    return Promise.reject(
      new SourceConfigError(
        'unreadable-geotiff',
        `GeoTIFF '${id}': cannot read it (${error instanceof Error ? error.message : String(error)})`,
      ),
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
