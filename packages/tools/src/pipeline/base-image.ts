// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** The whole-world equirectangular image the engine pins as its base (F338), written next to the tile pyramid. */
import { join } from 'node:path';
import type { DatasetConfig } from '../config/schema.js';
import { encodeJpeg } from '../encode/jpeg.js';
import type { Mosaic } from '../raster/mosaic.js';
import type { DatasetFolders } from './raster-dataset.js';

/** Samples the mosaic over the whole world (pixel centers, 2×2 supersampling) as 8-bit RGB. */
function equirectangularPixels(mosaic: Mosaic, width: number): Uint8Array {
  const height = width / 2;
  const rgb = new Uint8Array(width * height * 3);
  const sample = new Float64Array(mosaic.channels);
  const step = 360 / width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sum = [0, 0, 0];
      for (let s = 0; s < 4; s++) {
        mosaic.sample(-180 + (x + 0.25 + 0.5 * (s % 2)) * step, 90 - (y + 0.25 + 0.5 * (s >> 1)) * step, sample);
        for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + (sample[c] ?? 0);
      }
      for (let c = 0; c < 3; c++)
        rgb[(y * width + x) * 3 + c] = Math.max(0, Math.min(255, Math.round((sum[c] ?? 0) / 4)));
    }
  }
  return rgb;
}

/** Writes `<id>-base.jpg` into the output folder unless its logged checksum still matches; returns its path. */
export function writeBaseImage(
  dataset: DatasetConfig,
  mosaic: Mosaic,
  outputFolder: string,
  folders: DatasetFolders,
): string {
  const options = dataset.baseImage ?? { widthPx: 4096, quality: 88 };
  const path = join(outputFolder, `${dataset.id}-base.jpg`);
  if (folders.log.check('base', dataset.id, path) === 'done') return path;
  const rgb = equirectangularPixels(mosaic, options.widthPx);
  folders.log.write('base', dataset.id, path, encodeJpeg(rgb, options.widthPx, options.widthPx / 2, options.quality));
  folders.report(`wrote ${path}`);
  return path;
}
