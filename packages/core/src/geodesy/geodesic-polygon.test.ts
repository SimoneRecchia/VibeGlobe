import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import referenceJson from './fixtures/geodesic-polygons.json?raw';
import { geodesicDirect } from './geodesic-direct.js';
import {
  ELLIPSOID_AREA_SQUARE_METERS,
  type GeodesicPoint,
  geodesicPathLengthMeters,
  geodesicPolygonArea,
} from './geodesic-polygon.js';

/** Reference shapes (see the `note` field of fixtures/geodesic-polygons.json for how they were computed). */
interface PolygonReference {
  note: string;
  polylines: { name: string; points: [number, number][]; lengthMeters: number }[];
  polygons: { name: string; points: [number, number][]; areaSquareMeters: number; perimeterMeters: number }[];
}

const REFERENCE = JSON.parse(referenceJson) as PolygonReference;
/** Acceptance criteria: lengths within 1 mm, areas within 1 m². */
const LENGTH_TOLERANCE_METERS = 1e-3;
const AREA_TOLERANCE_SQUARE_METERS = 1;

function toPoints(pairs: [number, number][]): GeodesicPoint[] {
  return pairs.map(([longitudeDeg, latitudeDeg]) => ({ longitudeDeg, latitudeDeg }));
}

describe('geodesic polylines and polygons against GeographicLib', () => {
  it.each(REFERENCE.polylines.map((line) => [line.name, line] as const))('measures the %s', (_name, line) => {
    const length = geodesicPathLengthMeters(toPoints(line.points));
    expect(Math.abs(length - line.lengthMeters)).toBeLessThanOrEqual(LENGTH_TOLERANCE_METERS);
  });

  it.each(REFERENCE.polygons.map((polygon) => [polygon.name, polygon] as const))(
    'measures the %s',
    (_name, polygon) => {
      const result = geodesicPolygonArea(toPoints(polygon.points));
      expect(Math.abs(result.areaSquareMeters - polygon.areaSquareMeters)).toBeLessThanOrEqual(
        AREA_TOLERANCE_SQUARE_METERS,
      );
      expect(Math.abs(result.perimeterMeters - polygon.perimeterMeters)).toBeLessThanOrEqual(LENGTH_TOLERANCE_METERS);
    },
  );

  it('includes polygons that enclose either pole and polygons that cross the antimeridian', () => {
    const names = REFERENCE.polygons.map((polygon) => polygon.name).join('\n');
    expect(names).toMatch(/around the north pole/);
    expect(names).toMatch(/around the south pole/);
    expect(names).toMatch(/crossing the antimeridian/);
  });
});

describe('degenerate input', () => {
  it('gives zero for fewer than two or three points', () => {
    expect(geodesicPathLengthMeters([])).toBe(0);
    expect(geodesicPathLengthMeters([{ longitudeDeg: 1, latitudeDeg: 2 }])).toBe(0);
    expect(geodesicPolygonArea([])).toEqual({ areaSquareMeters: 0, perimeterMeters: 0 });
    const twoPoints = geodesicPolygonArea([
      { longitudeDeg: 0, latitudeDeg: 0 },
      { longitudeDeg: 1, latitudeDeg: 1 },
    ]);
    expect(twoPoints.areaSquareMeters).toBe(0);
    expect(twoPoints.perimeterMeters).toBeCloseTo(
      2 *
        geodesicPathLengthMeters(
          toPoints([
            [0, 0],
            [1, 1],
          ]),
        ),
      6,
    );
  });

  it('reports the ellipsoid area of WGS84', () => {
    expect(ELLIPSOID_AREA_SQUARE_METERS).toBeCloseTo(5.10065621724e14, -3);
  });
});

/** A star-shaped polygon around a center, counter-clockwise: vertices at decreasing azimuths, gaps under 180°. */
const starPolygon = fc
  .record({
    lon: fc.double({ min: -180, max: 180, noNaN: true }),
    lat: fc.double({ min: -80, max: 80, noNaN: true }),
    radius: fc.double({ min: 10, max: 2e6, noNaN: true }),
    jitter: fc.array(
      fc.tuple(fc.double({ min: 0, max: 0.4, noNaN: true }), fc.double({ min: 0.5, max: 1, noNaN: true })),
      {
        minLength: 3,
        maxLength: 12,
      },
    ),
  })
  .map(({ lon, lat, radius, jitter }) =>
    jitter.map(([angle, scale], i): GeodesicPoint => {
      const end = geodesicDirect(lon, lat, (-360 * (i + angle)) / jitter.length, radius * scale);
      return { longitudeDeg: end.longitudeDeg, latitudeDeg: end.latitudeDeg };
    }),
  );

/**
 * Edge areas S12 of these polygons stay below about 1e13 m², so compensated summation in a different order changes the
 * result by a few ulps of that, under 0.01 m².
 */
const SUMMATION_TOLERANCE_SQUARE_METERS = 0.01;

describe('geodesic polygon area properties', () => {
  test.prop([starPolygon, fc.nat()])('is invariant to rotating the vertex order', (points, shift) => {
    const k = shift % points.length;
    const rotated = [...points.slice(k), ...points.slice(0, k)];
    const area = geodesicPolygonArea(points);
    const rotatedArea = geodesicPolygonArea(rotated);
    expect(Math.abs(rotatedArea.areaSquareMeters - area.areaSquareMeters)).toBeLessThanOrEqual(
      SUMMATION_TOLERANCE_SQUARE_METERS,
    );
    expect(rotatedArea.perimeterMeters).toBeCloseTo(area.perimeterMeters, 6);
  });

  test.prop([starPolygon])('is positive counter-clockwise and changes sign with the orientation', (points) => {
    const area = geodesicPolygonArea(points);
    const reversed = geodesicPolygonArea([...points].reverse());
    expect(area.areaSquareMeters).toBeGreaterThan(0);
    expect(Math.abs(reversed.areaSquareMeters + area.areaSquareMeters)).toBeLessThanOrEqual(
      SUMMATION_TOLERANCE_SQUARE_METERS,
    );
    expect(reversed.perimeterMeters).toBeCloseTo(area.perimeterMeters, 6);
  });
});
