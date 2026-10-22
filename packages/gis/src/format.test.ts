import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { measureDistance } from './measure.js';
import { formatCoordinate, type CoordinateFormat } from './format.js';
import { parseCoordinate } from './parse.js';
import { utmZone } from './utm.js';

const MILAN = { longitudeDeg: 9.19, latitudeDeg: 45.464211 };
const SYDNEY = { longitudeDeg: 151.2093, latitudeDeg: -33.8688 };

describe('coordinate formats (F405)', () => {
  it.each([
    [MILAN, 'decimal', 5, '45.46421°N 9.19000°E'],
    [MILAN, 'decimal', 2, '45.46°N 9.19°E'],
    [SYDNEY, 'decimal', 4, '33.8688°S 151.2093°E'],
    [{ longitudeDeg: -0.000004, latitudeDeg: -0.000004 }, 'decimal', 5, '0.00000°N 0.00000°E'],
    [MILAN, 'dms', 1, '45°27′51.2″N 9°11′24.0″E'],
    [MILAN, 'dms', 0, '45°27′51″N 9°11′24″E'],
    [SYDNEY, 'dms', 2, '33°52′07.68″S 151°12′33.48″E'],
    [{ longitudeDeg: -74.0445, latitudeDeg: 40.6892 }, 'dms', 0, '40°41′21″N 74°02′40″W'],
    // 9.999986° is 9°59′59.95″: rounding to whole seconds carries into minutes and degrees, never 60″.
    [{ longitudeDeg: 9.999986, latitudeDeg: 0.999999 }, 'dms', 0, '1°00′00″N 10°00′00″E'],
    [{ longitudeDeg: 9.999986, latitudeDeg: 0.999999 }, 'dms', 1, '1°00′00.0″N 9°59′59.9″E'],
    [{ longitudeDeg: -180, latitudeDeg: 0 }, 'decimal', 1, '0.0°N 180.0°E'],
    [{ longitudeDeg: 190, latitudeDeg: 0 }, 'decimal', 1, '0.0°N 170.0°W'],
  ] as const)('%o as %s with precision %i', (position, format, precision, expected) => {
    expect(formatCoordinate(position, format, { precision })).toBe(expected);
  });

  it('formats UTM with zone, latitude band and configurable precision', () => {
    // The projection itself matches exact reference values within 1 mm (crs.test.ts).
    expect(formatCoordinate(MILAN, 'utm')).toBe('32T 514853 5034538');
    expect(formatCoordinate(MILAN, 'utm', { precision: 2 })).toMatch(/^32T 514853\.\d\d 5034538\.\d\d$/);
    expect(formatCoordinate(SYDNEY, 'utm')).toBe('56H 334369 6250948');
    expect(formatCoordinate({ longitudeDeg: 5, latitudeDeg: 60 }, 'utm')).toMatch(/^32V /);
    expect(formatCoordinate({ longitudeDeg: 10, latitudeDeg: 78 }, 'utm')).toMatch(/^33X /);
    expect(formatCoordinate({ longitudeDeg: 0, latitudeDeg: 85 }, 'utm')).toBeUndefined();
    expect(formatCoordinate({ longitudeDeg: 0, latitudeDeg: -81 }, 'utm')).toBeUndefined();
    expect(formatCoordinate({ longitudeDeg: 179.99, latitudeDeg: 1 }, 'utm')).toMatch(/^60N /);
  });

  it('follows the Norway and Svalbard zone exceptions', () => {
    expect([
      utmZone(3.5, 60),
      utmZone(2.9, 60),
      utmZone(8, 75),
      utmZone(20, 75),
      utmZone(30, 75),
      utmZone(40, 75),
    ]).toEqual([32, 31, 31, 33, 35, 37]);
  });

  it('writes a decimal comma for locales that use one', () => {
    expect(formatCoordinate(MILAN, 'decimal', { precision: 3, decimalSeparator: ',' })).toBe('45,464°N 9,190°E');
    expect(parseCoordinate('45,464°N 9,190°E')).toEqual({ longitudeDeg: 9.19, latitudeDeg: 45.464 });
  });

  it('rejects invalid input', () => {
    expect(() => formatCoordinate({ longitudeDeg: 0, latitudeDeg: 91 }, 'decimal')).toThrow(RangeError);
    expect(() => formatCoordinate({ longitudeDeg: NaN, latitudeDeg: 0 }, 'dms')).toThrow(RangeError);
    expect(() => formatCoordinate(MILAN, 'decimal', { precision: 1.5 })).toThrow(RangeError);
  });
});

describe('coordinate parsing (F405, F426)', () => {
  it.each([
    ['45.4642, 9.19', 9.19, 45.4642],
    ['45.4642 9.19', 9.19, 45.4642],
    ['-33.8688; 151.2093', 151.2093, -33.8688],
    ['9.19°E 45.4642°N', 9.19, 45.4642],
    ['N 45.4642 E 9.19', 9.19, 45.4642],
    ['45°27′51.2″N 9°11′24.0″E', 9.19, 45 + 27 / 60 + 51.2 / 3600],
    [`45°27'51.2"N 9°11'24"E`, 9.19, 45 + 27 / 60 + 51.2 / 3600],
    ['45 27 51.2 N 9 11 24 E', 9.19, 45 + 27 / 60 + 51.2 / 3600],
    ['45 27 51.2 9 11 24', 9.19, 45 + 27 / 60 + 51.2 / 3600],
    ["N 45° 27.5' W 9° 11.4'", -(9 + 11.4 / 60), 45 + 27.5 / 60],
    ['33°52′07.68″S 151°12′33.48″E', 151 + 12 / 60 + 33.48 / 3600, -(33 + 52 / 60 + 7.68 / 3600)],
  ])('reads %s', (text, lon, lat) => {
    const parsed = parseCoordinate(text);
    expect(parsed?.longitudeDeg).toBeCloseTo(lon, 10);
    expect(parsed?.latitudeDeg).toBeCloseTo(lat, 10);
  });

  it('reads UTM, the band letter selecting the hemisphere', () => {
    const milan = parseCoordinate('32T 514853 5034538');
    const sydney = parseCoordinate('56h 334369 6250948');
    expect(measureDistance(milan ?? MILAN, MILAN).distanceMeters).toBeLessThan(1);
    expect(measureDistance(sydney ?? MILAN, SYDNEY).distanceMeters).toBeLessThan(1);
  });

  it.each([
    '',
    'Milan',
    '45.4642',
    '45.4642, 9.19, 3',
    '95, 9',
    '45, 190',
    '45°61′ N 9° E',
    '45°N 9°N',
    '-45°S 9°E',
    '45°27\'-5" N 9 E',
    '45.5 30 N 9 E',
    '61Z 1 1',
    "45' 9°",
  ])('rejects %j', (text) => {
    expect(parseCoordinate(text)).toBeUndefined();
  });

  const position = fc.record({
    longitudeDeg: fc.double({ min: -180, max: 180, noNaN: true }),
    latitudeDeg: fc.double({ min: -90, max: 90, noNaN: true }),
  });
  const PRECISION_DEG: Readonly<Record<Exclude<CoordinateFormat, 'utm'>, (p: number) => number>> = {
    decimal: (p) => 0.5 * 10 ** -p,
    dms: (p) => (0.5 * 10 ** -p) / 3600,
  };

  test.prop([position, fc.constantFrom('decimal' as const, 'dms' as const), fc.integer({ min: 0, max: 8 })])(
    'parsing a formatted decimal or DMS coordinate returns it within the format precision',
    (point, format, precision) => {
      const text = formatCoordinate(point, format, { precision }) ?? '';
      const parsed = parseCoordinate(text);
      const tolerance = PRECISION_DEG[format](precision) * (1 + 1e-9) + 1e-12;
      expect(parsed).toBeDefined();
      expect(Math.abs((parsed?.latitudeDeg ?? NaN) - point.latitudeDeg)).toBeLessThanOrEqual(tolerance);
      const dLon = Math.abs((parsed?.longitudeDeg ?? NaN) - point.longitudeDeg);
      expect(Math.min(dLon, 360 - dLon)).toBeLessThanOrEqual(tolerance);
    },
  );

  test.prop([
    fc.record({
      longitudeDeg: fc.double({ min: -180, max: 180, noNaN: true }),
      latitudeDeg: fc.double({ min: -80, max: 84, noNaN: true }),
    }),
    fc.integer({ min: 0, max: 4 }),
  ])('parsing a formatted UTM coordinate returns it within the format precision', (point, precision) => {
    const parsed = parseCoordinate(formatCoordinate(point, 'utm', { precision }) ?? '');
    // Easting and northing each round by half a unit of the last digit; scale factors stay below 1.001 in a zone.
    const toleranceMeters = Math.SQRT2 * 0.5 * 10 ** -precision * 1.001 + 1e-6;
    expect(measureDistance(parsed ?? { longitudeDeg: NaN, latitudeDeg: NaN }, point).distanceMeters).toBeLessThan(
      toleranceMeters,
    );
  });
});
