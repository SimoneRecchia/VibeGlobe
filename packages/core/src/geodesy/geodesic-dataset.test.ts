import { describe, expect, it } from 'vitest';
import reference from './fixtures/geodesic-reference.txt?raw';
import { geodesicDirect } from './geodesic-direct.js';
import { OUT_AREA, OUT_AZIMUTH1, OUT_AZIMUTH2, OUT_DISTANCE, solveInverse } from './geodesic-inverse.js';
import { GEOD_C2_SQUARE_METERS } from './geodesic-series.js';

/** One reference geodesic (see the header of fixtures/geodesic-reference.txt). */
interface ReferenceRow {
  category: string;
  lat1: number;
  lon1: number;
  azi1: number;
  lat2: number;
  lon2: number;
  azi2: number;
  s12: number;
  m12: number;
  areaS12: number;
}

function parseReference(text: string): ReferenceRow[] {
  const rows: ReferenceRow[] = [];
  let category = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('@')) category = line.slice(1).trim();
    if (line.startsWith('@') || line.startsWith('#') || line.trim() === '') continue;
    const [
      lat1 = NaN,
      lon1 = NaN,
      azi1 = NaN,
      lat2 = NaN,
      lon2 = NaN,
      azi2 = NaN,
      s12 = NaN,
      m12 = NaN,
      areaS12 = NaN,
    ] = line.split(' ').map(Number);
    rows.push({ category, lat1, lon1, azi1, lat2, lon2, azi2, s12, m12, areaS12 });
  }
  return rows;
}

const ROWS = parseReference(reference);
const DEG = Math.PI / 180;
/** Acceptance criterion for distances: 0.1 mm. */
const DISTANCE_TOLERANCE_METERS = 1e-4;
/** Acceptance criterion for azimuths: 1e-9 degrees. */
const AZIMUTH_TOLERANCE_DEG = 1e-9;
/**
 * Where an azimuth is ill-conditioned the 1e-9° criterion is replaced by its effect on the far end point. An error δα
 * in the azimuth at point 1 moves point 2 by |m12| δα (m12, the reduced length, vanishes for coincident and conjugate
 * points), and merely rounding the reference end point to doubles moves it by up to ~1.6 nm. No double-precision
 * solver can then hold 1e-9° (GeographicLib's own errors against Karney's GeodTest reach 6e-9° on 6 m lines and 4e-4°
 * between conjugate vertices), so the azimuth is accepted when it misplaces the end point by under 10 nm.
 */
const END_POINT_DISPLACEMENT_TOLERANCE_METERS = 1e-8;

/** Absolute difference of two azimuths in degrees, modulo 360. */
function azimuthErrorDeg(actual: number, expected: number): number {
  return Math.abs(wrapDeg(actual - expected));
}

/** Reduces an angle difference to [-180, 180] degrees without losing the precision of small differences. */
function wrapDeg(angleDeg: number): number {
  const reduced = angleDeg % 360;
  if (reduced > 180) return reduced - 360;
  return reduced < -180 ? reduced + 360 : reduced;
}

function azimuthAccepted(errorDeg: number, m12: number): boolean {
  return errorDeg <= AZIMUTH_TOLERANCE_DEG || errorDeg * DEG * Math.abs(m12) <= END_POINT_DISPLACEMENT_TOLERANCE_METERS;
}

describe('geodesic reference data (2000 geodesics in the categories of Karney’s GeodTest)', () => {
  it('covers every category of the test set plus special cases', () => {
    const categories = new Set(ROWS.map((row) => row.category));
    expect(ROWS).toHaveLength(2000);
    expect(categories.size).toBe(10);
  });

  it('solves the inverse problem: distances within 0.1 mm, azimuths within 1e-9° where well-conditioned', () => {
    let worstDistance = 0;
    for (const row of ROWS) {
      const out = solveInverse(row.lon1, row.lat1, row.lon2, row.lat2, false);
      const distanceError = Math.abs((out[OUT_DISTANCE] ?? NaN) - row.s12);
      worstDistance = Math.max(worstDistance, distanceError);
      expect(distanceError, `${row.category}: ${JSON.stringify(row)}`).toBeLessThanOrEqual(DISTANCE_TOLERANCE_METERS);
      const errors = [
        azimuthErrorDeg(out[OUT_AZIMUTH1] ?? NaN, row.azi1),
        azimuthErrorDeg(out[OUT_AZIMUTH2] ?? NaN, row.azi2),
      ];
      for (const error of errors) expect(azimuthAccepted(error, row.m12), `${row.category} ${error}`).toBe(true);
    }
    expect(worstDistance).toBeLessThan(1e-7);
  });

  it('meets 1e-9° on the azimuths of every inverse problem whose end points pin them down (|m12| ≥ 10 km)', () => {
    const wellConditioned = ROWS.filter((row) => Math.abs(row.m12) >= 1e4);
    expect(wellConditioned.length).toBeGreaterThan(1500);
    for (const row of wellConditioned) {
      const out = solveInverse(row.lon1, row.lat1, row.lon2, row.lat2, false);
      expect(azimuthErrorDeg(out[OUT_AZIMUTH1] ?? NaN, row.azi1)).toBeLessThanOrEqual(AZIMUTH_TOLERANCE_DEG);
      expect(azimuthErrorDeg(out[OUT_AZIMUTH2] ?? NaN, row.azi2)).toBeLessThanOrEqual(AZIMUTH_TOLERANCE_DEG);
    }
  });

  it('computes the edge area S12 to 1 m², apart from the effect of ill-conditioned azimuths (c² δα)', () => {
    for (const row of ROWS) {
      const out = solveInverse(row.lon1, row.lat1, row.lon2, row.lat2, true);
      const azimuthErrorRad =
        (azimuthErrorDeg(out[OUT_AZIMUTH1] ?? NaN, row.azi1) + azimuthErrorDeg(out[OUT_AZIMUTH2] ?? NaN, row.azi2)) *
        DEG;
      const tolerance = 1 + GEOD_C2_SQUARE_METERS * azimuthErrorRad;
      expect(Math.abs((out[OUT_AREA] ?? NaN) - row.areaS12), row.category).toBeLessThanOrEqual(tolerance);
    }
  });

  it('solves the direct problem: end points within 0.1 mm, final azimuths within 1e-9°', () => {
    let worstPosition = 0;
    for (const row of ROWS) {
      const end = geodesicDirect(row.lon1, row.lat1, row.azi1, row.s12);
      const dLonDeg = wrapDeg(end.longitudeDeg - row.lon2);
      const dLatDeg = end.latitudeDeg - row.lat2;
      // Position error in meters on a sphere of radius a: an upper bound for the ellipsoid to within 1%.
      const positionError = 6378137 * DEG * Math.hypot(dLatDeg, dLonDeg * Math.cos(row.lat2 * DEG));
      worstPosition = Math.max(worstPosition, positionError);
      expect(positionError, `${row.category}: ${JSON.stringify(row)}`).toBeLessThanOrEqual(DISTANCE_TOLERANCE_METERS);
      // Next to a pole the azimuth turns with longitude (meridian convergence, sin φ per unit of longitude), so it is
      // compared in a frame that does not rotate with the longitude's last bits.
      const azimuthError = azimuthErrorDeg(end.finalAzimuthDeg - Math.sin(row.lat2 * DEG) * dLonDeg, row.azi2);
      expect(azimuthError, row.category).toBeLessThanOrEqual(AZIMUTH_TOLERANCE_DEG);
    }
    expect(worstPosition).toBeLessThan(1e-7);
  });
});
