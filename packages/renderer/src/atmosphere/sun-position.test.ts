import { describe, expect, it } from 'vitest';
import { subsolarPoint, sunDirectionEcef } from './sun-position.js';

/**
 * Reference sub-solar points from Astronomy Engine 2.1.19 (MIT, VSOP87-based, about 1″): the apparent equatorial
 * coordinates of date seen from the geocenter and Greenwich apparent sidereal time, generated once. The 2024 equinoxes
 * and solstices are at the instants published by the US Naval Observatory.
 */
const REFERENCES = [
  { utc: '2024-03-20T03:06:00Z', latitudeDeg: 0, longitudeDeg: 135.3565 },
  { utc: '2024-06-20T20:51:00Z', latitudeDeg: 23.4378, longitudeDeg: -132.3057 },
  { utc: '2024-09-22T12:44:00Z', latitudeDeg: 0, longitudeDeg: -12.872 },
  { utc: '2024-12-21T09:21:00Z', latitudeDeg: -23.4391, longitudeDeg: 39.311 },
  { utc: '2000-01-01T12:00:00Z', latitudeDeg: -23.0336, longitudeDeg: 0.8212 },
  { utc: '1992-10-13T00:00:00Z', latitudeDeg: -7.784, longitudeDeg: 176.5734 },
  { utc: '2026-10-22T15:30:00Z', latitudeDeg: -11.2064, longitudeDeg: -56.3887 },
  { utc: '2031-07-04T06:15:00Z', latitudeDeg: 22.8814, longitudeDeg: 87.3513 },
  { utc: '1980-02-29T23:59:00Z', latitudeDeg: -7.6068, longitudeDeg: -176.6412 },
] as const;

/** The angle between two unit vectors, in degrees. */
function angleDeg(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const dot = (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
  return Math.acos(Math.min(1, Math.max(-1, dot))) / (Math.PI / 180);
}

function unit(latitudeDeg: number, longitudeDeg: number): number[] {
  const lat = (latitudeDeg * Math.PI) / 180;
  const lon = (longitudeDeg * Math.PI) / 180;
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
}

describe('sun position (F396)', () => {
  it.each(REFERENCES)('matches the reference ephemeris within 0.1° at $utc', (reference) => {
    const direction = sunDirectionEcef(Date.parse(reference.utc), new Float64Array(3));
    const error = angleDeg(direction, unit(reference.latitudeDeg, reference.longitudeDeg));
    expect(error).toBeLessThan(0.1);
    // The formulas are good to about 0.01°: a larger error means a wrong term, even within the requirement.
    expect(error).toBeLessThan(0.02);
  });

  it('crosses the equator at the equinoxes and reaches the tropics at the solstices', () => {
    expect(Math.abs(subsolarPoint(Date.parse('2024-03-20T03:06:00Z')).latitudeDeg)).toBeLessThan(0.01);
    expect(subsolarPoint(Date.parse('2024-06-20T20:51:00Z')).latitudeDeg).toBeCloseTo(23.44, 1);
  });

  it('moves west by 15° per hour', () => {
    const start = Date.parse('2024-06-01T00:00:00Z');
    const a = subsolarPoint(start).longitudeDeg;
    const b = subsolarPoint(start + 3_600_000).longitudeDeg;
    expect(a - b).toBeCloseTo(15, 1);
  });
});
