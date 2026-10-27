// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Series expansions of the geodesic integrals on the WGS84 ellipsoid, following C. F. F. Karney, "Algorithms for
 * geodesics", J. Geodesy 87 (2013). The tables were derived for this engine by exact rational expansion of the
 * paper's integrands (described above each table), not copied from an implementation.
 *
 * Notation: n = f / (2 - f) is the third flattening, e'² the second eccentricity squared, k² = e'² cos²α₀ for a
 * geodesic whose azimuth at the equator is α₀, ε = k² / (√(1 + k²) + 1)² and z = e^{2iσ} on the auxiliary sphere.
 * The distance series are complete to order ε⁶ and the longitude series to total order 6 in (n, ε), truncation errors
 * far below 1e-15 relative; the area series is complete to total degree 6 in (e'², k²), a truncation error below
 * 1e-4 m² per edge.
 */
import { WGS84 } from './wgs84.js';

/** Equatorial radius a, in meters. */
export const GEOD_A_METERS = WGS84.semiMajorAxisMeters;
/** Polar radius b, in meters. */
export const GEOD_B_METERS = WGS84.semiMinorAxisMeters;
/** Flattening f. */
export const GEOD_F = WGS84.flattening;
/** First eccentricity squared e². */
export const GEOD_E2 = WGS84.firstEccentricitySquared;
/** Second eccentricity squared e'² = e² / (1 - e²). */
export const GEOD_EP2 = GEOD_E2 / (1 - GEOD_E2);
/** Squared authalic radius c² = a²/2 + (b²/2) atanh(e) / e, in square meters; the ellipsoid's area is 4πc². */
export const GEOD_C2_SQUARE_METERS =
  (GEOD_A_METERS * GEOD_A_METERS) / 2 +
  ((GEOD_B_METERS * GEOD_B_METERS) / 2) * (Math.atanh(Math.sqrt(GEOD_E2)) / Math.sqrt(GEOD_E2));

const TERMS = 6;
const AREA_TERMS = 7;
const THIRD_FLATTENING = GEOD_F / (2 - GEOD_F);

// I1(σ) = ∫₀^σ √(1 + k² sin²σ') dσ' = A1 (σ + Σₗ C1ₗ sin 2lσ), where √(1 + k² sin²σ) = |1 - εz| / (1 - ε) is
// expanded binomially in ε. Entries are the coefficients of ε⁰, ε¹, ...; rows of C1 are l = 1..6.
const A1_EPS = [1, 1, 5 / 4, 5 / 4, 81 / 64, 81 / 64, 325 / 256];
const C1_EPS = [
  [0, -1 / 2, 0, 3 / 16, 0, -1 / 32],
  [0, 0, -1 / 16, 0, 1 / 32, 0, -9 / 2048],
  [0, 0, 0, -1 / 48, 0, 3 / 256],
  [0, 0, 0, 0, -5 / 512, 0, 3 / 512],
  [0, 0, 0, 0, 0, -7 / 1280],
  [0, 0, 0, 0, 0, 0, -7 / 2048],
];

// I2(σ) = ∫₀^σ dσ' / √(1 + k² sin²σ') = A2 (σ + Σₗ C2ₗ sin 2lσ), with the integrand (1 - ε) / |1 - εz|; it enters
// the reduced length through J = I1 - I2.
const A2_EPS = [1, -1, 1 / 4, -1 / 4, 9 / 64, -9 / 64, 25 / 256];
const C2_EPS = [
  [0, 1 / 2, 0, 1 / 16, 0, 1 / 32],
  [0, 0, 3 / 16, 0, 1 / 32, 0, 35 / 2048],
  [0, 0, 0, 5 / 48, 0, 5 / 256],
  [0, 0, 0, 0, 35 / 512, 0, 7 / 512],
  [0, 0, 0, 0, 0, 63 / 1280],
  [0, 0, 0, 0, 0, 0, 77 / 2048],
];

// I3(σ) = ∫₀^σ (2 - f) / (1 + (1 - f) √(1 + k² sin²σ')) dσ' = A3 σ + Σₗ D3ₗ sin 2lσ, the longitude correction
// λ = ω - f sinα₀ I3. With f = 2n / (1 + n) the integrand is 2 (1 - ε) / ((1 + n)(1 - ε) + (1 - n)|1 - εz|).
// A3: outer index the power of ε, entries the coefficients of n⁰, n¹, ...; D3: one such table per l = 1..6.
const A3_EPS_N = [
  [1],
  [-1 / 2, 1 / 2],
  [-1 / 4, -1 / 8, 3 / 8],
  [-1 / 16, -3 / 16, -1 / 16, 5 / 16],
  [-3 / 64, -1 / 32, -5 / 32],
  [-3 / 128, -5 / 128],
  [-5 / 256],
];
const D3_EPS_N = [
  [
    [0],
    [1 / 4, -1 / 4],
    [0, 1 / 4, -1 / 4],
    [-5 / 64, 9 / 64, 11 / 64, -15 / 64],
    [-1 / 32, -1 / 32, 5 / 32],
    [-7 / 256, -1 / 256],
    [-1 / 64],
  ],
  [
    [0],
    [0],
    [1 / 16, -3 / 32, 1 / 32],
    [1 / 64, 3 / 64, -7 / 64, 3 / 64],
    [-1 / 64, 1 / 16],
    [-1 / 128, 1 / 128],
    [-17 / 2048],
  ],
  [[0], [0], [0], [5 / 192, -3 / 64, 5 / 192, -1 / 192], [1 / 96, 1 / 96, -5 / 96], [-7 / 1536, 47 / 1536], [-1 / 384]],
  [[0], [0], [0], [0], [7 / 512, -7 / 256, 5 / 256], [7 / 1024, 1 / 1024], [-3 / 2048]],
  [[0], [0], [0], [0], [0], [21 / 2560, -9 / 512], [3 / 640]],
  [[0], [0], [0], [0], [0], [0], [11 / 2048]],
];

// I4(σ) = -∫_{π/2}^σ (t(e'²) - t(k² sin²σ')) / (e'² - k² sin²σ') (sinσ' / 2) dσ' = Σᵣ C4ᵣ cos((2r + 1)σ), where
// t(x) = x + √(1 + 1/x) asinh(√x); the quotient is expanded in powers of e'² and k² sin²σ, and odd powers of sinσ
// are written as sums of sin((2r + 1)σ). Outer index: r; middle index: power of k²; entries: coefficients of e'²ⁱ.
const C4_K_EP2 = [
  [
    [2 / 3, -1 / 15, 4 / 105, -8 / 315, 64 / 3465, -128 / 9009, 512 / 45045],
    [-1 / 20, 1 / 35, -2 / 105, 16 / 1155, -32 / 3003, 128 / 15015],
    [1 / 42, -1 / 63, 8 / 693, -80 / 9009, 64 / 9009],
    [-1 / 72, 1 / 99, -10 / 1287, 8 / 1287],
    [1 / 110, -1 / 143, 4 / 715],
    [-1 / 156, 1 / 195],
    [1 / 210],
  ],
  [
    [0],
    [1 / 180, -1 / 315, 2 / 945, -16 / 10395, 32 / 27027, -128 / 135135],
    [-1 / 252, 1 / 378, -4 / 2079, 40 / 27027, -32 / 27027],
    [1 / 360, -1 / 495, 2 / 1287, -8 / 6435],
    [-1 / 495, 2 / 1287, -8 / 6435],
    [5 / 3276, -1 / 819],
    [-1 / 840],
  ],
  [
    [0],
    [0],
    [1 / 2100, -1 / 3150, 4 / 17325, -8 / 45045, 32 / 225225],
    [-1 / 1800, 1 / 2475, -2 / 6435, 8 / 32175],
    [1 / 1925, -2 / 5005, 8 / 25025],
    [-1 / 2184, 1 / 2730],
    [1 / 2520],
  ],
  [
    [0],
    [0],
    [0],
    [1 / 17640, -1 / 24255, 2 / 63063, -8 / 315315],
    [-1 / 10780, 1 / 14014, -2 / 35035],
    [5 / 45864, -1 / 11466],
    [-1 / 8820],
  ],
  [[0], [0], [0], [0], [1 / 124740, -1 / 162162, 2 / 405405], [-1 / 58968, 1 / 73710], [1 / 41580]],
  [[0], [0], [0], [0], [0], [1 / 792792, -1 / 990990], [-1 / 304920]],
  [[0], [0], [0], [0], [0], [0], [1 / 4684680]],
];

/** Evaluates the polynomial Σ coefs[i] xⁱ by Horner's rule. */
function polynomial(coefs: ArrayLike<number>, x: number): number {
  let sum = 0;
  for (let i = coefs.length - 1; i >= 0; i--) sum = sum * x + (coefs[i] ?? 0);
  return sum;
}

/** Flattens rows of ε polynomials into a (rows × 7) table, row-major, padding with zeros. */
function epsTable(rows: readonly (readonly number[])[]): Float64Array {
  const table = new Float64Array(rows.length * (TERMS + 1));
  rows.forEach((row, l) => table.set(row, l * (TERMS + 1)));
  return table;
}

/** Collapses the n polynomials of the longitude series for WGS84's third flattening into ε polynomials. */
function longitudeTables(): { a3: Float64Array; d3: Float64Array } {
  const a3 = Float64Array.from(A3_EPS_N, (inN) => polynomial(inN, THIRD_FLATTENING));
  const d3 = new Float64Array(TERMS * (TERMS + 1));
  D3_EPS_N.forEach((row, l) => row.forEach((inN, p) => (d3[l * (TERMS + 1) + p] = polynomial(inN, THIRD_FLATTENING))));
  return { a3, d3 };
}

/** Collapses the e'² polynomials of the area series for WGS84 into k² polynomials, a (r × 7) table. */
function areaTable(): Float64Array {
  const table = new Float64Array(AREA_TERMS * AREA_TERMS);
  C4_K_EP2.forEach((row, r) => row.forEach((inEp2, m) => (table[r * AREA_TERMS + m] = polynomial(inEp2, GEOD_EP2))));
  return table;
}

const C1_TABLE = epsTable(C1_EPS);
const C2_TABLE = epsTable(C2_EPS);
const { a3: A3_TABLE, d3: D3_TABLE } = longitudeTables();
const C4_TABLE = areaTable();

/** The series coefficients of one geodesic, refreshed in place by {@link updateSeries} and {@link updateAreaSeries}. */
export interface GeodesicSeries {
  /** A1 of I1, the distance integral. */
  a1: number;
  /** A2 of I2, part of the reduced length. */
  a2: number;
  /** A3 of I3, the longitude integral. */
  a3: number;
  /** C1ₗ, l = 1..6. */
  readonly c1: Float64Array;
  /** C2ₗ, l = 1..6. */
  readonly c2: Float64Array;
  /** D3ₗ, l = 1..6 (I3 = A3 σ + Σ D3ₗ sin 2lσ). */
  readonly d3: Float64Array;
  /** C4ᵣ, r = 0..6 (I4 = Σ C4ᵣ cos((2r + 1)σ)). */
  readonly c4: Float64Array;
}

/** Allocates a coefficient set; solvers keep one at module level and refresh it for each geodesic. */
export function createSeries(): GeodesicSeries {
  return {
    a1: 0,
    a2: 0,
    a3: 0,
    c1: new Float64Array(TERMS),
    c2: new Float64Array(TERMS),
    d3: new Float64Array(TERMS),
    c4: new Float64Array(AREA_TERMS),
  };
}

/** Evaluates row `row` of a (rows × width) polynomial table at x. */
function tableRow(table: Float64Array, row: number, width: number, x: number): number {
  let sum = 0;
  for (let i = width - 1; i >= 0; i--) sum = sum * x + (table[row * width + i] ?? 0);
  return sum;
}

/** ε = k² / (√(1 + k²) + 1)², the expansion parameter of a geodesic with parameter k². */
export function epsilonFromK2(k2: number): number {
  const root = Math.sqrt(1 + k2) + 1;
  return k2 / (root * root);
}

/** Refreshes the distance, reduced-length and longitude coefficients of `series` for expansion parameter ε. */
export function updateSeries(series: GeodesicSeries, eps: number): void {
  const width = TERMS + 1;
  series.a1 = polynomial(A1_EPS, eps);
  series.a2 = polynomial(A2_EPS, eps);
  series.a3 = polynomial(A3_TABLE, eps);
  for (let l = 0; l < TERMS; l++) {
    series.c1[l] = tableRow(C1_TABLE, l, width, eps);
    series.c2[l] = tableRow(C2_TABLE, l, width, eps);
    series.d3[l] = tableRow(D3_TABLE, l, width, eps);
  }
}

/** Refreshes the area coefficients of `series` for parameter k². */
export function updateAreaSeries(series: GeodesicSeries, k2: number): void {
  for (let r = 0; r < AREA_TERMS; r++) series.c4[r] = tableRow(C4_TABLE, r, AREA_TERMS, k2);
}

/** Σₗ coefs[l - 1] sin 2lx for l = 1..coefs.length, by Clenshaw summation from sin x and cos x. */
export function sinSeries(coefs: Float64Array, sinX: number, cosX: number): number {
  const twoCos2x = 2 * (cosX - sinX) * (cosX + sinX);
  let next = 0;
  let afterNext = 0;
  for (let l = coefs.length - 1; l >= 0; l--) {
    const current = (coefs[l] ?? 0) + twoCos2x * next - afterNext;
    afterNext = next;
    next = current;
  }
  return 2 * sinX * cosX * next;
}

/** Σᵣ coefs[r] cos((2r + 1)x) for r = 0..coefs.length - 1, by Clenshaw summation from sin x and cos x. */
export function cosOddSeries(coefs: Float64Array, sinX: number, cosX: number): number {
  const twoCos2x = 2 * (cosX - sinX) * (cosX + sinX);
  let next = 0;
  let afterNext = 0;
  for (let r = coefs.length - 1; r >= 0; r--) {
    const current = (coefs[r] ?? 0) + twoCos2x * next - afterNext;
    afterNext = next;
    next = current;
  }
  return cosX * (next - afterNext);
}
