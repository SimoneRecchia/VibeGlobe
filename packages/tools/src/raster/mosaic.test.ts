import { describe, expect, it } from 'vitest';
import { Mosaic, type MosaicEntry } from './mosaic.js';
import type { Raster } from './tiff.js';

/** A 2 × 2 one-band raster filling the whole degree cell west-south of (lon, lat), every sample `value`. */
function cell(westDeg: number, southDeg: number, value: number): Raster {
  return {
    width: 2,
    height: 2,
    samplesPerPixel: 1,
    data: new Float32Array(4).fill(value),
    westDeg,
    northDeg: southDeg + 1,
    pixelWidthDeg: 0.5,
    pixelHeightDeg: 0.5,
  };
}

describe('Mosaic', () => {
  it('looks only at the files around a point, also where a file has no data (KB-323)', () => {
    let boundsRead = 0;
    const entries: MosaicEntry[] = [];
    for (let lat = 0; lat < 30; lat++)
      for (let lon = 0; lon < 30; lon++) {
        const bounds = { west: lon, south: lat, east: lon + 1, north: lat + 1 };
        const sea = (lon + lat) % 2 === 0;
        entries.push({
          get bounds() {
            boundsRead++;
            return bounds;
          },
          load: () => (sea ? undefined : cell(lon, lat, lon + 100 * lat)),
        });
      }
    const mosaic = new Mosaic(entries, 1, [-1]);
    const out = new Float64Array(1);
    boundsRead = 0;
    for (let i = 0; i < 100; i++) mosaic.sample(10.5, 20.5, out);
    expect(out[0]).toBe(-1);
    mosaic.sample(11.5, 20.5, out);
    expect(out[0]).toBe(2011);
    expect(boundsRead).toBeLessThan(1000);
  });
});
