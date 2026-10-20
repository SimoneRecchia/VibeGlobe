import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { ecefToGeodetic, geodeticToEcef, type GeodeticRad } from './ecef.js';

const DEG = Math.PI / 180;
const MM = 0.001;

// EPSG Guidance Note 7-2, method 9602 worked example (WGS84): 53°48'33.82"N, 2°07'46.38"E, h = 73.0 m.
const EPSG_EXAMPLE = {
  latitudeDeg: 53 + 48 / 60 + 33.82 / 3600,
  longitudeDeg: 2 + 7 / 60 + 46.38 / 3600,
  heightMeters: 73,
  x: 3771793.968,
  y: 140253.342,
  z: 5124304.349,
};

// Independent closed-form evaluation in Python (float64), rounded to the micrometer.
const REFERENCES = [
  { longitudeDeg: 9.19, latitudeDeg: 45.4642, heightMeters: 122, x: 4423531.73647, y: 715663.52295, z: 4523766.466234 },
  {
    longitudeDeg: -73.9857,
    latitudeDeg: 40.7484,
    heightMeters: 443,
    x: 1335028.253248,
    y: -4651415.040293,
    z: 4141585.182753,
  },
  { longitudeDeg: 180, latitudeDeg: 0, heightMeters: 0, x: -6378137, y: 0, z: 0 },
  {
    longitudeDeg: -179.9999,
    latitudeDeg: -33.8688,
    heightMeters: 58,
    x: -5301430.529789,
    y: -9.252742,
    z: -3534404.71091,
  },
  { longitudeDeg: 0, latitudeDeg: 90, heightMeters: 0, x: 0, y: 0, z: 6356752.314245 },
  { longitudeDeg: 45, latitudeDeg: -90, heightMeters: 2835, x: 0, y: 0, z: -6359587.314245 },
  {
    longitudeDeg: -122.4194,
    latitudeDeg: 37.7749,
    heightMeters: -12000,
    x: -2701089.774581,
    y: -4253052.691637,
    z: 3878374.759876,
  },
  {
    longitudeDeg: 151.2093,
    latitudeDeg: -33.8688,
    heightMeters: 40000000,
    x: -33753102.008437,
    y: 18548791.020814,
    z: -25826094.354153,
  },
  { longitudeDeg: -60, latitudeDeg: -89.999, heightMeters: 8848, x: 55.924203, y: -96.863561, z: -6365600.313269 },
  {
    longitudeDeg: 100,
    latitudeDeg: 10,
    heightMeters: 35786000,
    x: -7210602.193722,
    y: 40893357.129752,
    z: 7314422.233724,
  },
  { longitudeDeg: 25, latitudeDeg: -0.00001, heightMeters: -500, x: 5780102.075993, y: 2695305.862953, z: -1.105655 },
];

const ecef = new Float64Array(3);

/** The ECEF output as a tuple, so assertions need no index checks. */
function xyz(): [number, number, number] {
  const [x = NaN, y = NaN, z = NaN] = ecef;
  return [x, y, z];
}
const geodetic: GeodeticRad = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };

/** Wraps an angle difference to [-π, π). */
function wrapPi(angleRad: number): number {
  return angleRad - 2 * Math.PI * Math.floor((angleRad + Math.PI) / (2 * Math.PI));
}

/** Distance in meters along the ellipsoid surface spanned by an angle difference at a point, a conservative bound. */
function surfaceErrorMeters(latitudeRad: number, dLatRad: number, dLonRad: number, heightMeters: number): number {
  const radius = 6378137 + Math.max(0, heightMeters);
  return Math.hypot(dLatRad * radius, dLonRad * radius * Math.cos(latitudeRad));
}

describe('geodeticToEcef', () => {
  it('matches the EPSG Guidance Note 7-2 example within 1 mm', () => {
    const { longitudeDeg, latitudeDeg, heightMeters, x, y, z } = EPSG_EXAMPLE;
    geodeticToEcef(longitudeDeg * DEG, latitudeDeg * DEG, heightMeters, ecef);
    const [ex, ey, ez] = xyz();
    expect(Math.abs(ex - x)).toBeLessThan(MM);
    expect(Math.abs(ey - y)).toBeLessThan(MM);
    expect(Math.abs(ez - z)).toBeLessThan(MM);
  });

  it.each(REFERENCES)('matches the reference at $longitudeDeg, $latitudeDeg, $heightMeters m', (ref) => {
    geodeticToEcef(ref.longitudeDeg * DEG, ref.latitudeDeg * DEG, ref.heightMeters, ecef);
    const [ex, ey, ez] = xyz();
    expect(Math.hypot(ex - ref.x, ey - ref.y, ez - ref.z)).toBeLessThan(MM);
  });

  it('writes at an offset', () => {
    const buffer = new Float64Array(6);
    geodeticToEcef(0, 0, 0, buffer, 3);
    expect([...buffer]).toEqual([0, 0, 0, 6378137, 0, 0]);
  });
});

describe('ecefToGeodetic', () => {
  it.each([...REFERENCES, EPSG_EXAMPLE])('inverts the reference at $longitudeDeg, $latitudeDeg', (ref) => {
    ecefToGeodetic(ref.x, ref.y, ref.z, geodetic);
    const dLat = geodetic.latitudeRad - ref.latitudeDeg * DEG;
    const atPole = Math.abs(ref.latitudeDeg) === 90;
    const dLon = atPole ? 0 : wrapPi(geodetic.longitudeRad - ref.longitudeDeg * DEG);
    expect(surfaceErrorMeters(ref.latitudeDeg * DEG, dLat, dLon, ref.heightMeters)).toBeLessThan(MM);
    expect(Math.abs(geodetic.heightMeters - ref.heightMeters)).toBeLessThan(MM);
  });

  it('returns exactly ±90° at the poles', () => {
    ecefToGeodetic(0, 0, 6356752.314245, geodetic);
    expect(geodetic.latitudeRad).toBe(Math.PI / 2);
    expect(Math.abs(geodetic.heightMeters)).toBeLessThan(MM);
    ecefToGeodetic(0, 0, -7000000, geodetic);
    expect(geodetic.latitudeRad).toBe(-Math.PI / 2);
  });
});

describe('geodetic ⇄ ECEF round trip', () => {
  const longitude = fc.double({ min: -Math.PI, max: Math.PI, noNaN: true });
  const latitude = fc.oneof(
    fc.double({ min: -Math.PI / 2, max: Math.PI / 2, noNaN: true }),
    fc.constantFrom(Math.PI / 2, -Math.PI / 2, 0),
  );
  const height = fc.double({ min: -12000, max: 40000000, noNaN: true });

  test.prop([longitude, latitude, height])('stays within 1 mm everywhere, including the poles', (lon, lat, h) => {
    geodeticToEcef(lon, lat, h, ecef);
    const [x, y, z] = xyz();
    ecefToGeodetic(x, y, z, geodetic);
    geodeticToEcef(geodetic.longitudeRad, geodetic.latitudeRad, geodetic.heightMeters, ecef);
    const [rx, ry, rz] = xyz();
    expect(Math.hypot(rx - x, ry - y, rz - z)).toBeLessThan(MM);
    expect(Math.abs(geodetic.heightMeters - h)).toBeLessThan(MM);
    expect(Math.abs(geodetic.latitudeRad - lat) * 6378137).toBeLessThan(MM);
  });
});
