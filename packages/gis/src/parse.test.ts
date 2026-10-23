import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { formatCoordinate } from './format.js';
import { parseCoordinate, parseCoordinateResult } from './parse.js';
import { fromUtm, toUtm } from './utm.js';

describe('go to coordinates: decimal degrees (F204)', () => {
  it.each([
    ['45.4642, 9.19', 9.19, 45.4642],
    ['45.4642N 9.19E', 9.19, 45.4642],
    ['N45.4642 E9.19', 9.19, 45.4642],
    ['9.19E 45.4642N', 9.19, 45.4642],
    ['-33.86 151.21', 151.21, -33.86],
    ['33.86S, 151.21E', 151.21, -33.86],
    ['+45.4642 +9.19', 9.19, 45.4642],
  ])('reads %s, hemisphere letters deciding the axes, else latitude first', (text, lon, lat) => {
    expect(parseCoordinate(text)).toEqual({
      longitudeDeg: expect.closeTo(lon, 12),
      latitudeDeg: expect.closeTo(lat, 12),
    });
  });
});

describe('go to coordinates: degrees, minutes and seconds (F205)', () => {
  const milanLat = 45 + 27 / 60 + 51.1 / 3600;
  const milanLon = 9 + 11 / 60 + 24 / 3600;
  it.each([
    [`45°27'51.1"N 9°11'24.0"E`, milanLon, milanLat],
    ['45°27′51.1″N 9°11′24.0″E', milanLon, milanLat],
    ['45° 27.852′ N, 9° 11.4′ E', 9 + 11.4 / 60, 45 + 27.852 / 60],
    [`45° 27.852' N, 9° 11.4' E`, 9 + 11.4 / 60, 45 + 27.852 / 60],
    [`45°27'51.1"S 9°11'24.0"W`, -milanLon, -milanLat],
    ['-45°27′51.1″ -9°11′24.0″', -milanLon, -milanLat],
    ['45° 27.852′ S, 9° 11.4′ W', -(9 + 11.4 / 60), -(45 + 27.852 / 60)],
  ])('reads %s within 1e-9°', (text, lon, lat) => {
    const parsed = parseCoordinate(text);
    expect(Math.abs((parsed?.longitudeDeg ?? NaN) - lon)).toBeLessThan(1e-9);
    expect(Math.abs((parsed?.latitudeDeg ?? NaN) - lat)).toBeLessThan(1e-9);
  });
});

/**
 * Reference points computed with Krüger's series to sixth order (C. F. F. Karney, 2011), an implementation independent
 * of the proj4 path under test (`scripts/fixtures/tiles/utm.ts`); southern northings with the 10,000 km false northing.
 */
const UTM_REFERENCES = [
  { lon: 9.19, lat: 45.4642, zone: 32, band: 'T', easting: 514853.4959, northing: 5034536.7962 },
  { lon: 11.2558, lat: 43.7696, zone: 32, band: 'T', easting: 681557.2487, northing: 4848756.3856 },
  { lon: 12.4964, lat: 41.9028, zone: 33, band: 'T', easting: 292335.3131, northing: 4642015.5 },
  { lon: 14.2681, lat: 40.8518, zone: 33, band: 'T', easting: 438308.1774, northing: 4522563.4111 },
  { lon: 15.0873, lat: 37.5079, zone: 33, band: 'S', easting: 507715.6412, northing: 4151221.3682 },
  { lon: 151.2093, lat: -33.8688, zone: 56, band: 'H', easting: 334368.6336, northing: 6250948.3454 },
  { lon: -58.3816, lat: -34.6037, zone: 21, band: 'H', easting: 373317.5023, northing: 6170036.1713 },
] as const;

describe('go to coordinates: UTM (F206)', () => {
  it.each(UTM_REFERENCES)('converts $lon, $lat to and from $zone$band within 1 mm', (ref) => {
    const utm = toUtm(ref.lon, ref.lat);
    expect([utm?.zone, utm?.band]).toEqual([ref.zone, ref.band]);
    expect(Math.abs((utm?.eastingMeters ?? NaN) - ref.easting)).toBeLessThan(0.001);
    expect(Math.abs((utm?.northingMeters ?? NaN) - ref.northing)).toBeLessThan(0.001);
    const back = parseCoordinate(`${ref.zone}${ref.band} ${ref.easting} ${ref.northing}`);
    // 1 mm on the ground is about 1e-8°.
    expect(Math.abs((back?.longitudeDeg ?? NaN) - ref.lon)).toBeLessThan(1e-8);
    expect(Math.abs((back?.latitudeDeg ?? NaN) - ref.lat)).toBeLessThan(1e-8);
  });

  it('follows the Norway and Svalbard zone exceptions and validates zones and band letters', () => {
    // Bergen, west of 6°E but in zone 32V; Longyearbyen in zone 33X, Ny-Ålesund in 33X too (zones 32, 34 and 36 do
    // not exist in band X).
    expect(toUtm(5.32, 60.39)?.zone).toBe(32);
    expect(toUtm(15.63, 78.22)?.zone).toBe(33);
    expect(toUtm(11.93, 78.92)?.zone).toBe(33);
    for (const [zone, band] of [
      [32, 'X'],
      [34, 'X'],
      [36, 'X'],
      [61, 'T'],
      [0, 'T'],
      [32, 'I'],
      [32, 'O'],
      [32, 'Y'],
    ] as const)
      expect(() => fromUtm({ zone, band, eastingMeters: 500000, northingMeters: 5000000 })).toThrow(RangeError);
  });
});

describe('coordinate parsing: round trips, fuzzing and typed errors (F207)', () => {
  // Every format, positions including the poles, the antimeridian and UTM zone edges.
  const position = fc.oneof(
    fc.record({
      longitudeDeg: fc.double({ min: -180, max: 180, noNaN: true }),
      latitudeDeg: fc.double({ min: -90, max: 90, noNaN: true }),
    }),
    fc.record({
      longitudeDeg: fc.constantFrom(-180, 179.999999, -179.999999, 0, 5.9999999, 6, 12, 2.9999999, 3),
      latitudeDeg: fc.constantFrom(-90, 90, 0, 56, 64, 72, 84, -80, 83.9999),
    }),
  );
  test.prop([position, fc.constantFrom('decimal', 'dms', 'ddm' as const)], { numRuns: 400 })(
    'formats then parses back to the same position within the format precision',
    ({ longitudeDeg, latitudeDeg }, format) => {
      const text = formatCoordinate({ longitudeDeg, latitudeDeg }, format === 'ddm' ? 'dms' : format);
      if (text === undefined) return;
      const parsed = parseCoordinate(text);
      expect(parsed).toBeDefined();
      expect(Math.abs((parsed?.latitudeDeg ?? NaN) - latitudeDeg)).toBeLessThan(1e-4);
      // At the poles every longitude names the same point; across the antimeridian ±180° are one meridian.
      if (Math.abs(latitudeDeg) < 89.999) {
        const dLon = Math.abs((parsed?.longitudeDeg ?? NaN) - longitudeDeg);
        expect(Math.min(dLon, 360 - dLon)).toBeLessThan(1e-4);
      }
    },
  );

  test.prop([position.filter((p) => Math.abs(p.latitudeDeg) < 84 && p.latitudeDeg > -80)], { numRuns: 300 })(
    'UTM round trips within a millimeter, at zone edges too',
    ({ longitudeDeg, latitudeDeg }) => {
      const text = formatCoordinate({ longitudeDeg, latitudeDeg }, 'utm', { precision: 4 });
      const parsed = text === undefined ? undefined : parseCoordinate(text);
      expect(parsed).toBeDefined();
      expect(Math.abs((parsed?.latitudeDeg ?? NaN) - latitudeDeg)).toBeLessThan(1e-7);
      const dLon = Math.abs((parsed?.longitudeDeg ?? NaN) - longitudeDeg);
      expect(Math.min(dLon, 360 - dLon)).toBeLessThan(1e-7);
    },
  );

  // The fuzzer: arbitrary strings and mutations of valid ones; none throws, none takes long.
  const valid = fc.constantFrom('45.4642, 9.19', `45°27'51.1"N 9°11'24.0"E`, '32T 514853 5034537', 'N45 E9');
  const mutated = fc
    .tuple(valid, fc.nat(30), fc.string({ maxLength: 4 }))
    .map(([text, at, insert]) => text.slice(0, at) + insert + text.slice(at + 1));
  test.prop([fc.oneof(fc.string({ maxLength: 60 }), fc.string({ unit: 'grapheme', maxLength: 40 }), mutated)], {
    numRuns: 5000,
  })('never throws or hangs on any text', (text) => {
    const started = performance.now();
    const result = parseCoordinateResult(text);
    expect(performance.now() - started).toBeLessThan(50);
    expect(result.position !== undefined || result.error !== undefined).toBe(true);
  });

  it.each([
    ['95, 9', 'latitude-out-of-range'],
    ['45, 190', 'longitude-out-of-range'],
    ['61T 500000 5000000', 'invalid-utm-zone'],
    ['32X 500000 8700000', 'invalid-utm-zone'],
    ['45°61′ N 9° E', 'invalid-minutes-or-seconds'],
    ['Milan%45', 'unrecognized'],
    ['', 'unrecognized'],
  ])('reports %j as a typed error (%s)', (text, code) => {
    const result = parseCoordinateResult(text);
    expect(result.position).toBeUndefined();
    expect(result.error?.code).toBe(code);
    expect(result.error?.message.length).toBeGreaterThan(10);
  });
});
