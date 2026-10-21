import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeLzw } from './lzw.js';
import { readGeoTiff } from './tiff.js';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));

describe('readGeoTiff', () => {
  it('reads a Copernicus DEM tile (float32, DEFLATE, floating-point predictor, pixel-is-point)', () => {
    const raster = readGeoTiff(fixture('copernicus-dem-mont-blanc.tif'));
    expect([raster.width, raster.height, raster.samplesPerPixel]).toEqual([256, 256, 1]);
    let max = -Infinity;
    let at = 0;
    raster.data.forEach((value, i) => {
      if (value > max) [max, at] = [value, i];
    });
    // The summit of Mont Blanc: 4,808 m at 45.8326°N, 6.8652°E (a surface model reads a little higher).
    expect(max).toBeCloseTo(4810.717, 3);
    const lon = raster.westDeg + ((at % 256) + 0.5) * raster.pixelWidthDeg;
    const lat = raster.northDeg - (Math.floor(at / 256) + 0.5) * raster.pixelHeightDeg;
    expect(lon).toBeCloseTo(6.8647, 3);
    expect(lat).toBeCloseTo(45.8328, 3);
  });

  it('reads RGB samples in LZW strips with pixel-is-area georeferencing', () => {
    const raster = readGeoTiff(fixture('rgb-lzw.tif'));
    expect([raster.width, raster.height, raster.samplesPerPixel]).toEqual([64, 32, 3]);
    expect([raster.westDeg, raster.northDeg, raster.pixelWidthDeg]).toEqual([10, 45, 0.25]);
    for (const [x, y] of [
      [0, 0],
      [63, 31],
      [17, 9],
    ] as const) {
      const at = (y * 64 + x) * 3;
      expect([...raster.data.subarray(at, at + 3)]).toEqual([(x * 4) & 255, (y * 8) & 255, ((x ^ y) * 16) & 255]);
    }
  });
});

describe('decodeLzw', () => {
  it('decodes the KwKwK case and width changes', () => {
    // Codes 256 (clear), 65 'A', 258 (= 'AA', defined by the code itself), 257 (end), packed in 9 bits.
    const codes = [256, 65, 258, 257];
    let bits = '';
    for (const code of codes) bits += code.toString(2).padStart(9, '0');
    const bytes = Uint8Array.from(bits.padEnd(Math.ceil(bits.length / 8) * 8, '0').match(/.{8}/g) ?? [], (b) =>
      parseInt(b, 2),
    );
    expect([...decodeLzw(bytes, 3)]).toEqual([65, 65, 65]);
  });
});
