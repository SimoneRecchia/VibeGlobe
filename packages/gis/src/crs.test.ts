import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { crsCodes, defineCrs, transformCoordinates } from './crs.js';

/**
 * Exact transverse Mercator values (WGS84, k0 = 0.9996, central meridian 0, no false origin) from C. F. F. Karney's
 * test set TMcoords.dat (GeographicLib, computed to 80 digits, here to 1 µm):
 * latitude, longitude from the central meridian, x and y in meters. UTM adds 500 km of false easting, and 10,000 km of false northing south of the equator.
 */
const TM_REFERENCE: readonly (readonly [number, number, number, number])[] = [
  [42.640218672601, 0.572483009384, 46933.5388065, 4721021.784855],
  [40.042378314835, 2.111686088716, 180148.5200239, 4434597.128271],
  [58.542492989325, 0.162592684741, 9464.9343875, 6489121.624944],
  [33.028801664026, 0.765842683855, 71519.4504575, 3654740.444852],
  [19.376879758731, 0.344604702538, 36187.3424147, 2142565.324802],
];
const MM = 0.001;

describe('built-in reference systems match reference values within 1 mm (F404)', () => {
  it.each(TM_REFERENCE)('UTM zones 32N and 33N at latitude %f', (lat, dLon, x, y) => {
    // East of zone 32's central meridian (9°E) and, mirrored, west of zone 33's (15°E).
    const east = transformCoordinates({ x: 9 + dLon, y: lat }, 'EPSG:4326', 'EPSG:32632');
    const west = transformCoordinates({ x: 15 - dLon, y: lat }, 'EPSG:4326', 'EPSG:32633');
    expect(Math.abs(east.x - (500000 + x))).toBeLessThan(MM);
    expect(Math.abs(east.y - y)).toBeLessThan(MM);
    expect(Math.abs(west.x - (500000 - x))).toBeLessThan(MM);
    expect(Math.abs(west.y - y)).toBeLessThan(MM);
    // The southern hemisphere's mirror image, in the WGS84 / UTM south zone.
    const south = transformCoordinates({ x: 9 + dLon, y: -lat }, 'EPSG:4326', 'EPSG:32732');
    expect(Math.abs(south.y - (10_000_000 - y))).toBeLessThan(MM);
  });

  it.each(TM_REFERENCE)('ETRS89 / UTM zones 32N and 33N at latitude %f', (lat, dLon, x, y) => {
    // GRS80 and WGS84 differ by 0.1 mm in the semi-minor axis: the same values hold within 1 mm.
    const east = transformCoordinates({ x: 9 + dLon, y: lat }, 'EPSG:4258', 'EPSG:25832');
    const west = transformCoordinates({ x: 15 - dLon, y: lat }, 'EPSG:4258', 'EPSG:25833');
    expect(Math.abs(east.x - (500000 + x))).toBeLessThan(MM);
    expect(Math.abs(east.y - y)).toBeLessThan(MM);
    expect(Math.abs(west.x - (500000 - x))).toBeLessThan(MM);
    expect(Math.abs(west.y - y)).toBeLessThan(MM);
  });

  it('Web Mercator: the EPSG Guidance Note 7-2 example and the closed form', () => {
    // GN 7-2, Popular Visualisation Pseudo Mercator: φ = 24°22'54.433"N, λ = 100°20'00.000"W →
    // E = -11 169 055.58 m, N = 2 800 000.00 m, published to the centimeter.
    const lat = 24 + 22 / 60 + 54.433 / 3600;
    const lon = -(100 + 20 / 60);
    const point = transformCoordinates({ x: lon, y: lat }, 'EPSG:4326', 'EPSG:3857');
    expect(Math.abs(point.x - -11169055.58)).toBeLessThan(0.005);
    expect(Math.abs(point.y - 2800000.0)).toBeLessThan(0.005);
    // The spherical formulas, exact: x = aλ, y = a ln tan(π/4 + φ/2).
    const a = 6378137;
    const rad = Math.PI / 180;
    expect(Math.abs(point.x - a * lon * rad)).toBeLessThan(MM);
    expect(Math.abs(point.y - a * Math.log(Math.tan(Math.PI / 4 + (lat * rad) / 2)))).toBeLessThan(MM);
  });

  it('ETRS89 and WGS84 geographic coordinates coincide', () => {
    expect(transformCoordinates({ x: 12.5, y: 41.9, z: 50 }, 'EPSG:4326', 'EPSG:4258')).toEqual({
      x: expect.closeTo(12.5, 12) as number,
      y: expect.closeTo(41.9, 12) as number,
      z: expect.closeTo(50, 6) as number,
    });
  });
});

describe('every built-in transform round-trips (F404)', () => {
  const projected = [
    ['EPSG:4326', 'EPSG:3857', 0],
    ['EPSG:4326', 'EPSG:32632', 9],
    ['EPSG:4326', 'EPSG:32633', 15],
    ['EPSG:4258', 'EPSG:25832', 9],
    ['EPSG:4258', 'EPSG:25833', 15],
  ] as const;
  // Within the systems' areas of use: UTM up to 3.5° from its central meridian, Web Mercator to ±85°.
  test.prop([fc.double({ min: -3.5, max: 3.5, noNaN: true }), fc.double({ min: -80, max: 84, noNaN: true })])(
    'geographic → projected → geographic within 1e-9° and 1 mm',
    (dLon, lat) => {
      for (const [geographic, code, centralLon] of projected) {
        const start = code === 'EPSG:3857' ? { x: dLon * 51, y: lat } : { x: centralLon + dLon, y: lat };
        const there = transformCoordinates(start, geographic, code);
        const back = transformCoordinates(there, code, geographic);
        expect(Math.abs(back.x - start.x)).toBeLessThan(1e-9);
        expect(Math.abs(back.y - start.y)).toBeLessThan(1e-9);
        const again = transformCoordinates(back, geographic, code);
        expect(Math.abs(again.x - there.x)).toBeLessThan(MM);
        expect(Math.abs(again.y - there.y)).toBeLessThan(MM);
      }
    },
  );
});

describe('custom reference systems (F404)', () => {
  it('transforms through a system defined from a PROJ string', () => {
    // UTM zone 32N written as a plain transverse Mercator: it must reproduce the built-in zone.
    defineCrs('test:tm9', '+proj=tmerc +lat_0=0 +lon_0=9 +k=0.9996 +x_0=500000 +y_0=0 +datum=WGS84 +units=m +no_defs');
    expect(crsCodes()).toContain('test:tm9');
    const [lat, dLon, x, y] = TM_REFERENCE[0] ?? [0, 0, 0, 0];
    const point = transformCoordinates({ x: 9 + dLon, y: lat }, 'EPSG:4326', 'test:tm9');
    expect(Math.abs(point.x - (500000 + x))).toBeLessThan(MM);
    expect(Math.abs(point.y - y)).toBeLessThan(MM);
    const utm = transformCoordinates(point, 'test:tm9', 'EPSG:32632');
    expect(Math.abs(utm.x - point.x)).toBeLessThan(MM);
    expect(Math.abs(utm.y - point.y)).toBeLessThan(MM);
  });

  it('rejects unknown codes, unparsable definitions and unmappable points', () => {
    expect(() => transformCoordinates({ x: 0, y: 0 }, 'EPSG:4326', 'EPSG:99999')).toThrow(RangeError);
    expect(() => defineCrs('test:bad', '+proj=nonsense')).toThrow();
    expect(crsCodes()).not.toContain('test:bad');
    expect(() => transformCoordinates({ x: 0, y: 90 }, 'EPSG:4326', 'EPSG:3857')).toThrow(RangeError);
  });
});
