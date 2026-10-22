import { describe, expect, it } from 'vitest';
import { formatArea, formatLength, measureArea, measureDistance, measurePathLength } from './measure.js';

describe('geodesic measurement', () => {
  it('measures distance and bearings on the ellipsoid', () => {
    // WGS84 quarter meridian, 10 001 965.729 m; equator, a·π/180 per degree. Core's geodesics pass Karney's dataset.
    const quarter = measureDistance({ longitudeDeg: 30, latitudeDeg: 0 }, { longitudeDeg: 30, latitudeDeg: 90 });
    expect(quarter.distanceMeters).toBeCloseTo(10001965.729, 3);
    expect(quarter.initialBearingDeg).toBe(0);
    const west = measureDistance({ longitudeDeg: 1, latitudeDeg: 0 }, { longitudeDeg: 0, latitudeDeg: 0 });
    expect(west.distanceMeters).toBeCloseTo((6378137 * Math.PI) / 180, 6);
    expect(west.initialBearingDeg).toBe(270);
    expect(west.finalBearingDeg).toBe(270);
  });

  it('measures path lengths and unsigned areas', () => {
    const square = [
      { longitudeDeg: 0, latitudeDeg: 0 },
      { longitudeDeg: 1, latitudeDeg: 0 },
      { longitudeDeg: 1, latitudeDeg: 1 },
      { longitudeDeg: 0, latitudeDeg: 1 },
    ];
    expect(measurePathLength(square.slice(0, 2))).toBeCloseTo(111319.49, 1);
    const clockwise = measureArea([...square].reverse());
    expect(clockwise.areaSquareMeters).toBeCloseTo(measureArea(square).areaSquareMeters, 3);
    // A 1° cell at the equator is about 12 309 km² on WGS84.
    expect(clockwise.areaSquareMeters / 1e6).toBeCloseTo(12308.8, 0);
    expect(measureArea(square.slice(0, 2)).areaSquareMeters).toBe(0);
  });

  it('scales units and follows the locale', () => {
    expect(formatLength(850)).toBe('850 m');
    expect(formatLength(12.345)).toBe('12.3 m');
    expect(formatLength(999.7)).toBe('1 km');
    expect(formatLength(1234)).toBe('1.23 km');
    expect(formatLength(1234, 'it')).toBe('1,23 km');
    expect(formatLength(1_234_567)).toBe('1,234.57 km');
    expect(formatArea(5000)).toBe('5,000 m²');
    expect(formatArea(2_500_000)).toBe('2.5 km²');
    expect(formatArea(2_500_000, 'it')).toBe('2,5 km²');
  });
});
