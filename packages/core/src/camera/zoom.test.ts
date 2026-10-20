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
    expect(Number.isFinite(groundZoomFromMercatorZoom(3, Math.PI / 2))).toBe(true);
  });
});
