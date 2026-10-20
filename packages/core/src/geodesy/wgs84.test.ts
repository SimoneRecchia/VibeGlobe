import { describe, expect, it } from 'vitest';
import { WGS84 } from './wgs84.js';

describe('WGS84', () => {
  it('matches the EPSG:7030 defining and derived parameters', () => {
    expect(WGS84.semiMajorAxisMeters).toBe(6378137);
    expect(1 / WGS84.flattening).toBeCloseTo(298.257223563, 9);
    expect(WGS84.semiMinorAxisMeters).toBeCloseTo(6356752.314245, 6);
    expect(WGS84.firstEccentricitySquared).toBeCloseTo(0.00669437999014, 14);
  });
});
