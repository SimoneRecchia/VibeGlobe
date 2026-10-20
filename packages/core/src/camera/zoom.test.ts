import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FOV_Y_RAD,
  groundMetersPerPixel,
  groundZoomForRange,
  groundZoomFromMercatorZoom,
  mercatorZoomFromGroundZoom,
  rangeForGroundZoom,
} from './zoom.js';

describe('zoom', () => {
  it('uses 512-pixel tiles: the equator spans 512 px at zoom 0 and each level halves the scale', () => {
    expect(groundMetersPerPixel(0) * 512).toBeCloseTo(2 * Math.PI * 6378137, 3);
    expect(groundMetersPerPixel(10) / groundMetersPerPixel(11)).toBeCloseTo(2, 12);
  });

  it('converts range and ground zoom both ways', () => {
    for (const zoom of [0, 5.5, 12, 22.3]) {
      const range = rangeForGroundZoom(zoom, 768, DEFAULT_FOV_Y_RAD);
      expect(groundZoomForRange(range, 768, DEFAULT_FOV_Y_RAD)).toBeCloseTo(zoom, 10);
    }
  });

  it('relates Mercator zoom to ground zoom through the scale factor 1 / cos φ', () => {
    const lat = (60 * Math.PI) / 180;
    expect(groundZoomFromMercatorZoom(10, lat)).toBeCloseTo(11, 12);
    expect(mercatorZoomFromGroundZoom(11, lat)).toBeCloseTo(10, 12);
    // At and beyond the Web Mercator limit the limit's scale factor applies (cosh π ≈ 11.59, so +3.53 levels).
    expect(groundZoomFromMercatorZoom(3, Math.PI / 2)).toBeCloseTo(3 + Math.log2(Math.cosh(Math.PI)), 9);
  });

  test.prop([
    fc.double({ min: -2, max: 30, noNaN: true }),
    fc.double({ min: -Math.PI / 2, max: Math.PI / 2, noNaN: true }),
    fc.integer({ min: 100, max: 4000 }),
  ])('round-trips zoom ⇄ range and Mercator ⇄ ground zoom at every latitude, poles included', (zoom, lat, heightPx) => {
    expect(
      groundZoomForRange(rangeForGroundZoom(zoom, heightPx, DEFAULT_FOV_Y_RAD), heightPx, DEFAULT_FOV_Y_RAD),
    ).toBeCloseTo(zoom, 9);
    expect(mercatorZoomFromGroundZoom(groundZoomFromMercatorZoom(zoom, lat), lat)).toBeCloseTo(zoom, 9);
    // Symmetric in latitude.
    expect(groundZoomFromMercatorZoom(zoom, lat)).toBeCloseTo(groundZoomFromMercatorZoom(zoom, -lat), 12);
  });
});
