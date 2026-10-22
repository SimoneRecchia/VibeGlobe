import { describe, expect, it } from 'vitest';
import type { DatasetConfig } from '../config/schema.js';
import type { Raster } from '../raster/tiff.js';
import { byteMapping, fillGaps } from './raster-dataset.js';

describe('WorldCover colour (ADR 0026)', () => {
  it('stretches reflectance with 255 × min(1, r / max) ^ (1 / gamma)', () => {
    const toByte = byteMapping({
      colorStretch: { maxReflectance: 3000, gamma: 2, noDataReflectance: [135, 245, 372] },
    } as DatasetConfig);
    expect([0, 750, 3000, 9000].map(toByte)).toEqual([0, 128, 255, 255]);
  });

  it('fills gaps by land-cover class and leaves water gaps and valid pixels alone', () => {
    // Three pixels: valid, a gap on snow (class 70), a gap on water (class 80).
    const image: Raster = {
      width: 3,
      height: 1,
      samplesPerPixel: 4,
      data: new Uint16Array([500, 600, 400, 2000, 0, 0, 0, 0, 0, 0, 0, 0]),
      westDeg: 6,
      northDeg: 46,
      pixelWidthDeg: 0.1,
      pixelHeightDeg: 0.1,
    };
    const classes: Raster = { ...image, samplesPerPixel: 1, data: new Uint8Array([10, 70, 80]) };
    fillGaps(image, classes, { '10': [1, 1, 1], '70': [3870, 4178, 4485] });
    expect([...image.data]).toEqual([500, 600, 400, 2000, 3870, 4178, 4485, 0, 0, 0, 0, 0]);
  });
});
