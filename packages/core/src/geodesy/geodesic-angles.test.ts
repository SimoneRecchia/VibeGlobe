import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { atan2Deg, longitudeDifferenceDeg, normalizeDeg, sinCosDeg } from './geodesic-angles.js';

const out = new Float64Array(2);

function sinCos(angleDeg: number): [number, number] {
  sinCosDeg(angleDeg, out, 0);
  return [out[0] ?? NaN, out[1] ?? NaN];
}

describe('sinCosDeg', () => {
  it('is exact at multiples of 90 degrees', () => {
    expect(sinCos(0)).toEqual([0, 1]);
    expect(sinCos(90)).toEqual([1, 0]);
    expect(sinCos(180)).toEqual([0, -1]);
    expect(sinCos(270)).toEqual([-1, 0]);
    expect(sinCos(-90)).toEqual([-1, 0]);
    expect(sinCos(720 + 90)).toEqual([1, 0]);
    expect(sinCos(-540)).toEqual([0, -1]);
  });

  it('writes at the given offset and propagates NaN', () => {
    const pair = new Float64Array(4);
    sinCosDeg(30, pair, 2);
    expect(pair[2]).toBeCloseTo(0.5, 15);
    expect(pair[3]).toBeCloseTo(Math.sqrt(3) / 2, 15);
    expect(sinCos(NaN).every(Number.isNaN)).toBe(true);
    expect(sinCos(Infinity).every(Number.isNaN)).toBe(true);
  });

  test.prop([fc.double({ min: -1080, max: 1080, noNaN: true })])('matches Math.sin and Math.cos', (angleDeg) => {
    const [s, c] = sinCos(angleDeg);
    expect(Math.abs(s - Math.sin((angleDeg * Math.PI) / 180))).toBeLessThanOrEqual(1e-14);
    expect(Math.abs(c - Math.cos((angleDeg * Math.PI) / 180))).toBeLessThanOrEqual(1e-14);
    expect(Math.hypot(s, c)).toBeCloseTo(1, 15);
  });
});

describe('angle reductions', () => {
  it('normalizes to (-180, 180] exactly', () => {
    expect(normalizeDeg(180)).toBe(180);
    expect(normalizeDeg(-180)).toBe(180);
    expect(normalizeDeg(540)).toBe(180);
    expect(normalizeDeg(181)).toBe(-179);
    expect(normalizeDeg(-181)).toBe(179);
    expect(normalizeDeg(359.5)).toBe(-0.5);
  });

  it('takes longitude differences across the antimeridian without losing bits', () => {
    expect(longitudeDifferenceDeg(179.9, -179.9)).toBeCloseTo(0.2, 13);
    expect(longitudeDifferenceDeg(-179.9, 179.9)).toBeCloseTo(-0.2, 13);
    // 170.0000000000003 + 170 rounds before the reduction by 360; the error-free sum keeps the lost bits.
    const lon2Deg = 170 + 3e-13;
    expect(lon2Deg + 170 - 360).not.toBe(lon2Deg - 170 - 20);
    expect(longitudeDifferenceDeg(-170, lon2Deg)).toBe(lon2Deg - 170 - 20);
    expect(longitudeDifferenceDeg(-170, 10)).toBe(180);
    expect(longitudeDifferenceDeg(10, -170)).toBe(-180);
    expect(longitudeDifferenceDeg(0, 540)).toBe(180);
    expect(longitudeDifferenceDeg(-90, 100)).toBe(-170);
  });

  test.prop([fc.double({ min: -720, max: 720, noNaN: true }), fc.double({ min: -720, max: 720, noNaN: true })])(
    'is antisymmetric and within [-180, 180]',
    (lon1Deg, lon2Deg) => {
      const forward = longitudeDifferenceDeg(lon1Deg, lon2Deg);
      expect(Math.abs(forward)).toBeLessThanOrEqual(180);
      expect(longitudeDifferenceDeg(lon2Deg, lon1Deg) + forward).toBe(0);
    },
  );

  it('reports atan2 in degrees within (-180, 180]', () => {
    expect(atan2Deg(-0, -1)).toBe(180);
    expect(atan2Deg(0, -1)).toBe(180);
    expect(atan2Deg(1, 0)).toBe(90);
    expect(atan2Deg(-1, 0)).toBe(-90);
    expect(Object.is(atan2Deg(-0, 1), 0)).toBe(true);
    expect(atan2Deg(NaN, 1)).toBeNaN();
  });
});
