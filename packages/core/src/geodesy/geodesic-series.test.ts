import { describe, expect, it } from 'vitest';
import {
  GEOD_C2_SQUARE_METERS,
  GEOD_EP2,
  GEOD_F,
  cosOddSeries,
  createSeries,
  epsilonFromK2,
  sinSeries,
  updateAreaSeries,
  updateSeries,
} from './geodesic-series.js';

// The series tables are checked against the integrals they expand (Karney 2013). Over a full
// period the trapezoidal rule is spectrally accurate, so it yields the Fourier coefficients to rounding error.
const SAMPLES = 256;

/** Mean and cos 2lσ Fourier coefficients (l = 1..6) of a π-periodic function. */
function fourierCos(fn: (sigma: number) => number): { mean: number; cos: number[] } {
  let mean = 0;
  const cos = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < SAMPLES; i++) {
    const sigma = (Math.PI * i) / SAMPLES;
    const value = fn(sigma);
    mean += value / SAMPLES;
    for (let l = 1; l <= 6; l++) cos[l - 1] = (cos[l - 1] ?? 0) + (2 * value * Math.cos(2 * l * sigma)) / SAMPLES;
  }
  return { mean, cos };
}

/** t(x) = x + √(1 + 1/x) asinh(√x), continued to t(0) = 1. */
function t(x: number): number {
  return x === 0 ? 1 : x + Math.sqrt(1 + 1 / x) * Math.asinh(Math.sqrt(x));
}

const K2_VALUES = [0, 0.2 * GEOD_EP2, 0.7 * GEOD_EP2, GEOD_EP2];
/** k² for WGS84 geodesics lies in [0, e'²]; 0.05 (ε ≈ 0.012) magnifies the truncation error to about ε⁷ ≈ 4e-14. */
const LARGE_K2 = 0.05;
/** Quadrature rounding: sums of 256 terms of order 1. */
const QUADRATURE_TOLERANCE = 1e-15;
/**
 * The I4 integrand divides t(e'²) - t(k² sin²σ) by e'² - k² sin²σ, both of order 1e-2, so the quadrature reference
 * itself carries errors of order 1e-15; the coefficients are still checked far beyond their 1e-7 to 1e-13 sizes.
 */
const AREA_QUADRATURE_TOLERANCE = 1e-14;

/** Rounding plus the series' truncation error, which is of order ε⁷. */
function tolerance(k2: number): number {
  return QUADRATURE_TOLERANCE + 4 * epsilonFromK2(k2) ** 7;
}

describe('geodesic series', () => {
  it('derives ε from k²', () => {
    expect(epsilonFromK2(0)).toBe(0);
    const k2 = 0.3;
    expect(epsilonFromK2(k2)).toBeCloseTo((Math.sqrt(1 + k2) - 1) / (Math.sqrt(1 + k2) + 1), 15);
  });

  it.each([...K2_VALUES, LARGE_K2])('expands the distance integral I1 and I2 (k² = %f)', (k2) => {
    const series = createSeries();
    updateSeries(series, epsilonFromK2(k2));
    const i1 = fourierCos((sigma) => Math.sqrt(1 + k2 * Math.sin(sigma) ** 2));
    const i2 = fourierCos((sigma) => 1 / Math.sqrt(1 + k2 * Math.sin(sigma) ** 2));
    expect(Math.abs(series.a1 - i1.mean)).toBeLessThan(tolerance(k2));
    expect(Math.abs(series.a2 - i2.mean)).toBeLessThan(tolerance(k2));
    for (let l = 1; l <= 6; l++) {
      // I = A (σ + Σ Cₗ sin 2lσ) integrates a cos 2lσ term of the integrand to (a / 2l) sin 2lσ.
      const c1Error = (series.c1[l - 1] ?? NaN) * series.a1 - (i1.cos[l - 1] ?? NaN) / (2 * l);
      const c2Error = (series.c2[l - 1] ?? NaN) * series.a2 - (i2.cos[l - 1] ?? NaN) / (2 * l);
      expect(Math.abs(c1Error)).toBeLessThan(tolerance(k2));
      expect(Math.abs(c2Error)).toBeLessThan(tolerance(k2));
    }
  });

  it.each([...K2_VALUES, LARGE_K2])('expands the longitude integral I3 (k² = %f)', (k2) => {
    const series = createSeries();
    updateSeries(series, epsilonFromK2(k2));
    const i3 = fourierCos((sigma) => (2 - GEOD_F) / (1 + (1 - GEOD_F) * Math.sqrt(1 + k2 * Math.sin(sigma) ** 2)));
    expect(Math.abs(series.a3 - i3.mean)).toBeLessThan(tolerance(k2));
    for (let l = 1; l <= 6; l++) {
      expect(Math.abs((series.d3[l - 1] ?? NaN) - (i3.cos[l - 1] ?? NaN) / (2 * l))).toBeLessThan(tolerance(k2));
    }
  });

  it.each(K2_VALUES.slice(0, 3))('expands the area integral I4 (k² = %f)', (k2) => {
    const series = createSeries();
    updateAreaSeries(series, k2);
    // dI4/dσ = -(t(e'²) - t(k² sin²σ)) / (e'² - k² sin²σ) · sinσ / 2 = -Σ (2r + 1) C4ᵣ sin((2r + 1)σ).
    const slope = (sigma: number): number => {
      const b = k2 * Math.sin(sigma) ** 2;
      return (-(t(GEOD_EP2) - t(b)) / (GEOD_EP2 - b)) * (Math.sin(sigma) / 2);
    };
    for (let r = 0; r < 7; r++) {
      let coefficient = 0;
      for (let i = 0; i < 2 * SAMPLES; i++) {
        const sigma = (Math.PI * i) / SAMPLES;
        coefficient += (slope(sigma) * Math.sin((2 * r + 1) * sigma)) / SAMPLES;
      }
      expect(Math.abs((series.c4[r] ?? NaN) + coefficient / (2 * r + 1))).toBeLessThan(AREA_QUADRATURE_TOLERANCE);
    }
  });

  it('sums sine and odd cosine series by Clenshaw recurrence', () => {
    const coefs = Float64Array.from([0.3, -0.2, 0.1, 0.05, -0.02, 0.01, 0.004]);
    for (const sigma of [-2.5, -0.3, 0, 0.7, 1.9, 3.1]) {
      let sines = 0;
      let cosines = 0;
      coefs.forEach((c, l) => {
        sines += c * Math.sin(2 * (l + 1) * sigma);
        cosines += c * Math.cos((2 * l + 1) * sigma);
      });
      expect(sinSeries(coefs, Math.sin(sigma), Math.cos(sigma))).toBeCloseTo(sines, 14);
      expect(cosOddSeries(coefs, Math.sin(sigma), Math.cos(sigma))).toBeCloseTo(cosines, 14);
    }
  });

  it('gives the WGS84 authalic radius', () => {
    // Authalic radius of WGS84: 6371007.1809 m.
    expect(Math.sqrt(GEOD_C2_SQUARE_METERS)).toBeCloseTo(6371007.1809, 4);
  });
});
