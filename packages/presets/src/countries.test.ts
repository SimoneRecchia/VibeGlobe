import { coverageArea, coverageTest } from '@vibeglobe/core';
import { describe, expect, it } from 'vitest';
import { COUNTRY_CODES, countryBorders } from './countries.js';

const DEG = Math.PI / 180;
/** A tile-sized box of 0.1° around a point, in radians. */
const around = (lon: number, lat: number) => ({
  westRad: (lon - 0.05) * DEG,
  southRad: (lat - 0.05) * DEG,
  eastRad: (lon + 0.05) * DEG,
  northRad: (lat + 0.05) * DEG,
});

describe('country borders (F618)', () => {
  it("loads a country's borders as GeoJSON that clips a source to the country", async () => {
    expect(COUNTRY_CODES).toContain('AT');
    const austria = coverageTest(coverageArea(await countryBorders('at')));
    // Vienna is inside, Munich (in Austria's bounding box) is not.
    expect(austria.covers(around(16.37, 48.21))).toBe(true);
    expect(austria.covers(around(11.58, 48.14))).toBe(false);
    await expect(countryBorders('XX')).rejects.toThrow(RangeError);
  });
});
