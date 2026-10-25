// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { describe, expect, it } from 'vitest';
import {
  EQUATORIAL_TO_GALACTIC,
  celestialToClip,
  celestialToEcef,
  ecefToGalactic,
  equatorialDirection,
  greenwichSiderealTimeRad,
} from './sky-orientation.js';

const DEG = Math.PI / 180;
const unixMsOfJulianDay = (jd: number): number => (jd - 2_440_587.5) * 86_400_000;

function apply(m: ArrayLike<number>, v: ArrayLike<number>): number[] {
  return [0, 1, 2].map((r) => [0, 1, 2].reduce((s, k) => s + (m[r * 3 + k] ?? 0) * (v[k] ?? 0), 0));
}

/** Right ascension and declination of a direction, degrees. */
function raDec(v: readonly number[]): [number, number] {
  const ra = Math.atan2(v[1] ?? 0, v[0] ?? 0) / DEG;
  return [ra < 0 ? ra + 360 : ra, Math.asin(v[2] ?? 0) / DEG];
}

describe('sky orientation (F602)', () => {
  it('gives Greenwich mean sidereal time as Meeus examples 12.a and 12.b', () => {
    // 1987 April 10, 0h UT: 13h 10m 46.3668s; 19h 21m UT: 8h 34m 57.0896s.
    expect(greenwichSiderealTimeRad(Date.UTC(1987, 3, 10)) / DEG).toBeCloseTo(197.693195, 5);
    expect(greenwichSiderealTimeRad(Date.UTC(1987, 3, 10, 19, 21)) / DEG).toBeCloseTo(128.7378734, 5);
  });

  it('precesses the J2000 catalog to the date as Meeus example 21.b (θ Persei, 2028)', () => {
    const utcMs = unixMsOfJulianDay(2_462_088.69);
    const ecef = apply(
      celestialToEcef(utcMs, new Float64Array(9)),
      equatorialDirection(41.054063, 49.22775, new Float64Array(3)),
    );
    // Undo the Earth's rotation: the right ascension and declination of the date.
    const g = greenwichSiderealTimeRad(utcMs);
    const ofDate = [
      Math.cos(g) * (ecef[0] ?? 0) - Math.sin(g) * (ecef[1] ?? 0),
      Math.sin(g) * (ecef[0] ?? 0) + Math.cos(g) * (ecef[1] ?? 0),
      ecef[2] ?? 0,
    ];
    const [ra, dec] = raDec(ofDate);
    expect(ra).toBeCloseTo(41.547214, 3);
    expect(dec).toBeCloseTo(49.348483, 3);
  });

  it('turns the sky once a sidereal day about the pole: Polaris stays near +z, a star on the equator circles', () => {
    const m = new Float64Array(9);
    const polaris = equatorialDirection(37.9546, 89.2641, new Float64Array(3));
    const rigel = equatorialDirection(78.6345, -8.2016, new Float64Array(3));
    const start = Date.UTC(2026, 5, 21, 12);
    const longitudes: number[] = [];
    for (let hour = 0; hour < 24; hour += 6) {
      celestialToEcef(start + hour * 3_600_000, m);
      expect(apply(m, polaris)[2]).toBeGreaterThan(0.9998);
      const e = apply(m, rigel);
      longitudes.push(Math.atan2(e[1] ?? 0, e[0] ?? 0) / DEG);
    }
    // Westward by 15.04° an hour of solar time.
    for (let i = 1; i < longitudes.length; i++) {
      const step = ((((longitudes[i - 1] ?? 0) - (longitudes[i] ?? 0)) % 360) + 360) % 360;
      expect(step).toBeCloseTo(90.2464, 2);
    }
  });

  it('places a star over the Greenwich meridian when its right ascension equals the sidereal time (J2000.0)', () => {
    // At J2000.0 the precession is zero.
    const utcMs = unixMsOfJulianDay(2_451_545);
    const ra = greenwichSiderealTimeRad(utcMs) / DEG;
    const e = apply(celestialToEcef(utcMs, new Float64Array(9)), equatorialDirection(ra, 20, new Float64Array(3)));
    expect(Math.atan2(e[1] ?? 0, e[0] ?? 0) / DEG).toBeCloseTo(0, 6);
    expect(Math.asin(e[2] ?? 0) / DEG).toBeCloseTo(20, 6);
  });

  it('maps the galactic center and the north galactic pole to the galactic axes', () => {
    const center = apply(EQUATORIAL_TO_GALACTIC, equatorialDirection(266.40499, -28.93617, new Float64Array(3)));
    const pole = apply(EQUATORIAL_TO_GALACTIC, equatorialDirection(192.85948, 27.12825, new Float64Array(3)));
    expect(center[0]).toBeCloseTo(1, 6);
    expect(pole[2]).toBeCloseTo(1, 6);
    // ECEF to galactic undoes the Earth's rotation and precession at any time.
    const t = Date.UTC(2031, 0, 5, 3);
    const v = equatorialDirection(10, 40, new Float64Array(3));
    const back = apply(ecefToGalactic(t, new Float64Array(9)), apply(celestialToEcef(t, new Float64Array(9)), v));
    apply(EQUATORIAL_TO_GALACTIC, v).forEach((value, i) => expect(back[i]).toBeCloseTo(value, 9));
  });

  it('projects a celestial direction as projection · view rotation · celestialToEcef, ignoring the eye position', () => {
    // A view looking along −z from far away, rotated by 30° about x, with a translation, and an infinite reversed-z projection.
    const c = Math.cos(30 * DEG);
    const s = Math.sin(30 * DEG);
    const view = [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 1e7, -2e7, 3e7, 1];
    const projection = [1.5, 0, 0, 0, 0, 2, 0, 0, 0.1, -0.2, 0, -1, 0, 0, 1, 0];
    const m = celestialToEcef(Date.UTC(2026, 9, 25, 21), new Float64Array(9));
    const out = celestialToClip(view, projection, m, new Float64Array(16));
    const d = equatorialDirection(123, -45, new Float64Array(3));
    const ecef = apply(m, d);
    const eye = [0, 1, 2].map(
      (k) =>
        (view[k] ?? 0) * (ecef[0] ?? 0) + (view[4 + k] ?? 0) * (ecef[1] ?? 0) + (view[8 + k] ?? 0) * (ecef[2] ?? 0),
    );
    const expected = [0, 1, 2, 3].map((i) =>
      [0, 1, 2].reduce((sum, k) => sum + (projection[k * 4 + i] ?? 0) * (eye[k] ?? 0), 0),
    );
    const actual = [0, 1, 2, 3].map((i) => [0, 1, 2].reduce((sum, j) => sum + (out[j * 4 + i] ?? 0) * (d[j] ?? 0), 0));
    actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i] ?? 0, 12));
    expect([...out.slice(12)]).toEqual([0, 0, 0, 0]);
  });
});
