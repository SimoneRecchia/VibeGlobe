import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import {
  WORLD_WIDTH_METERS,
  degToRad,
  nearestWorldCopyXMeters,
  radToDeg,
  wrapLongitudeDeg,
  wrapLongitudeRad,
} from './longitude.js';

describe('longitude wrapping', () => {
  it('maps ±π to -π and leaves in-range values untouched', () => {
    expect(wrapLongitudeRad(Math.PI)).toBe(-Math.PI);
    expect(wrapLongitudeRad(-Math.PI)).toBe(-Math.PI);
    expect(wrapLongitudeRad(3 * Math.PI)).toBe(-Math.PI);
    expect(wrapLongitudeRad(1.25)).toBe(1.25);
    expect(wrapLongitudeRad(-0)).toBe(-0);
  });

  it('wraps degrees exactly', () => {
    expect(wrapLongitudeDeg(180)).toBe(-180);
    expect(wrapLongitudeDeg(540)).toBe(-180);
    expect(wrapLongitudeDeg(-190)).toBe(170);
    expect(wrapLongitudeDeg(359.5)).toBe(-0.5);
    expect(Math.abs(wrapLongitudeDeg(-360))).toBe(0);
  });

  it('gives NaN for non-finite input', () => {
    expect(wrapLongitudeRad(Number.POSITIVE_INFINITY)).toBeNaN();
    expect(wrapLongitudeDeg(Number.NEGATIVE_INFINITY)).toBeNaN();
    expect(wrapLongitudeRad(Number.NaN)).toBeNaN();
  });

  it('converts ±180° and ±90° exactly', () => {
    expect(degToRad(-180)).toBe(-Math.PI);
    expect(degToRad(90)).toBe(Math.PI / 2);
    expect(radToDeg(Math.PI)).toBe(180);
    expect(radToDeg(-Math.PI / 2)).toBe(-90);
  });

  test.prop([fc.double({ noNaN: true, noDefaultInfinity: true })])('radians land in [-π, π)', (lonRad) => {
    const wrapped = wrapLongitudeRad(lonRad);
    expect(wrapped).toBeGreaterThanOrEqual(-Math.PI);
    expect(wrapped).toBeLessThan(Math.PI);
  });

  // Over |λ| ≤ 1000 at most 160 periods are removed; each differs from a true 2π by 2.4e-16, hence 1e-12.
  test.prop([fc.double({ min: -1000, max: 1000, noNaN: true })])('radians keep the direction', (lonRad) => {
    const wrapped = wrapLongitudeRad(lonRad);
    expect(Math.abs(Math.sin(wrapped) - Math.sin(lonRad))).toBeLessThanOrEqual(1e-12);
    expect(Math.abs(Math.cos(wrapped) - Math.cos(lonRad))).toBeLessThanOrEqual(1e-12);
  });

  test.prop([fc.double({ noNaN: true, noDefaultInfinity: true })])('degrees land in [-180°, 180°)', (lonDeg) => {
    const wrapped = wrapLongitudeDeg(lonDeg);
    expect(wrapped).toBeGreaterThanOrEqual(-180);
    expect(wrapped).toBeLessThan(180);
  });

  // While 360·k stays below 2^53 the difference is computed exactly, so it must be a whole number of turns.
  test.prop([fc.double({ min: -1e12, max: 1e12, noNaN: true })])('degrees shift by whole turns', (lonDeg) => {
    expect(Number.isInteger((lonDeg - wrapLongitudeDeg(lonDeg)) / 360)).toBe(true);
  });
});

describe('nearestWorldCopyXMeters', () => {
  it('moves a point across the antimeridian next to the reference', () => {
    const half = WORLD_WIDTH_METERS / 2;
    expect(nearestWorldCopyXMeters(-half + 10, half - 10)).toBeCloseTo(half + 10, 6);
    expect(nearestWorldCopyXMeters(5, 0)).toBe(5);
  });

  const x = fc.double({ min: -1e9, max: 1e9, noNaN: true });
  test.prop([x, x])(
    'lands within half a world of the reference, by whole world widths',
    (xMeters, referenceXMeters) => {
      const nearest = nearestWorldCopyXMeters(xMeters, referenceXMeters);
      expect(Math.abs(nearest - referenceXMeters)).toBeLessThanOrEqual(WORLD_WIDTH_METERS / 2 + 1e-6);
      const copies = (nearest - xMeters) / WORLD_WIDTH_METERS;
      expect(Math.abs(copies - Math.round(copies))).toBeLessThanOrEqual(1e-9);
    },
  );
});
