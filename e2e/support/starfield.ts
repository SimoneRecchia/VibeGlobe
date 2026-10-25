// Helpers of the space background's end-to-end tests (ADR 0181): the catalog read from its asset, predictions written
// independently of the engine (sidereal time and precession from Meeus's formulas, ch. 12 and 21, the first-order
// precession in right ascension and declination), and a pinhole camera fitted to the engine's public `screenToGeo` (a
// direction from the eye maps to the screen by a 3 × 3 projective matrix, found from ground points by least squares).
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { openGlobe, waitForIdle } from './globe.ts';

export const DEG = Math.PI / 180;
const A = 6_378_137;
const E2 = 0.00669437999014;
/** The playground's default sky time: the engine's fixed epoch (ADR 0181). */
export const EPOCH_MS = Date.UTC(2026, 5, 21, 12);

/**
 * The catalog's stars brighter than a magnitude, decoded here from `bsc5-stars.bin` (ADR 0181's encoding): right
 * ascension and declination in radians.
 */
export function catalogStars(magnitude: number): { ra: number; dec: number; magnitude: number }[] {
  const bytes = readFileSync(new URL('../../packages/renderer/src/starfield/bsc5-stars.bin', import.meta.url));
  const stars: { ra: number; dec: number; magnitude: number }[] = [];
  for (let at = 0; at + 6 <= bytes.length && (bytes[at + 4] ?? 0) / 25 - 2 < magnitude; at += 6)
    stars.push({
      ra: (bytes.readUInt16LE(at) / 65_536) * 2 * Math.PI,
      dec: (bytes.readInt16LE(at + 2) / 32_767) * 90 * DEG,
      magnitude: (bytes[at + 4] ?? 0) / 25 - 2,
    });
  return stars;
}

interface StarsHandle {
  visibility: number;
  skyTimeMs: number;
  setOptions(options: Record<string, unknown>): void;
  remove(): void;
}
export type StarsWindow = Window & { vibeglobeStars?: StarsHandle };

export async function openStars(page: Page, query: string): Promise<void> {
  await openGlobe(page, `stars=1&${query}`);
  await page.waitForFunction(() => ((window as StarsWindow).vibeglobeStars?.skyTimeMs ?? 0) > 0);
  await waitForIdle(page);
}

export async function setStars(page: Page, options: Record<string, unknown>): Promise<void> {
  await page.evaluate((o) => (window as StarsWindow).vibeglobeStars?.setOptions(o), options);
  await waitForIdle(page);
}

/** Greenwich mean sidereal time, degrees (Meeus 12.4). */
export function siderealDeg(utcMs: number): number {
  const d = utcMs / 86_400_000 + 2_440_587.5 - 2_451_545;
  const t = d / 36_525;
  return (((280.46061837 + 360.98564736629 * d + 0.000387933 * t * t) % 360) + 360) % 360;
}

/** The ECEF direction of a J2000 position at a time: first-order precession, then the Earth's rotation. */
export function starEcef(raRad: number, decRad: number, utcMs: number): [number, number, number] {
  const years = (utcMs - Date.UTC(2000, 0, 1, 12)) / (365.25 * 86_400_000);
  // Annual precession: m = 3.07496 s, n = 1.33621 s = 20.0431″.
  const m = 46.1244 / 3600;
  const n = 20.0431 / 3600;
  const ra = raRad + (m + n * Math.sin(raRad) * Math.tan(decRad)) * years * DEG;
  const dec = decRad + n * Math.cos(raRad) * years * DEG;
  const hour = ra - siderealDeg(utcMs) * DEG;
  return [Math.cos(dec) * Math.cos(hour), Math.cos(dec) * Math.sin(hour), Math.sin(dec)];
}

function geodeticToEcef(lonDeg: number, latDeg: number, h: number): [number, number, number] {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  const nRadius = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
  return [
    (nRadius + h) * Math.cos(lat) * Math.cos(lon),
    (nRadius + h) * Math.cos(lat) * Math.sin(lon),
    (nRadius * (1 - E2) + h) * Math.sin(lat),
  ];
}

/** Solves the square system `m · x = b` by Gaussian elimination with partial pivoting. */
function solve(m: number[][], b: number[]): number[] {
  const n = b.length;
  const a = m.map((row, i) => [...row, b[i] ?? 0]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r]?.[c] ?? 0) > Math.abs(a[pivot]?.[c] ?? 0)) pivot = r;
    [a[c], a[pivot]] = [a[pivot] ?? [], a[c] ?? []];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = (a[r]?.[c] ?? 0) / (a[c]?.[c] ?? 1);
      for (let k = c; k <= n; k++) (a[r] as number[])[k] = (a[r]?.[k] ?? 0) - f * (a[c]?.[k] ?? 0);
    }
  }
  return a.map((row, i) => (row[n] ?? 0) / (row[i] ?? 1));
}

/**
 * The 3 × 3 matrix h (row-major) whose rows give a screen point as (h1·d / h3·d, h2·d / h3·d) for a direction d from the
 * eye, by least squares over ground points, with h3's entry along the largest component of `forward` fixed to 1.
 */
function fitProjective(
  pairs: readonly { screen: { xPx: number; yPx: number }; d: number[] }[],
  forward: readonly number[],
): number[] {
  const fixed = 6 + forward.reduce((best, v, k) => (Math.abs(v) > Math.abs(forward[best] ?? 0) ? k : best), 0);
  const free = [0, 1, 2, 3, 4, 5, 6, 7, 8].filter((k) => k !== fixed);
  const normal = free.map(() => free.map(() => 0));
  const rhs = free.map(() => 0);
  for (const { screen, d } of pairs)
    for (const [row, target] of [
      [0, screen.xPx],
      [1, screen.yPx],
    ] as const) {
      // h_row · d − target · h3 · d = 0, as a linear equation in the nine entries.
      const coefficients = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((k) => {
        const r = Math.floor(k / 3);
        const value = d[k % 3] ?? 0;
        return (r === row ? value : 0) - (r === 2 ? target * value : 0);
      });
      const constant = -(coefficients[fixed] ?? 0);
      free.forEach((a, i) => {
        free.forEach(
          (b, j) =>
            ((normal[i] as number[])[j] = (normal[i]?.[j] ?? 0) + (coefficients[a] ?? 0) * (coefficients[b] ?? 0)),
        );
        rhs[i] = (rhs[i] ?? 0) + (coefficients[a] ?? 0) * constant;
      });
    }
  const h = new Array<number>(9).fill(0);
  solve(normal, rhs).forEach((value, i) => (h[free[i] ?? 0] = value));
  h[fixed] = 1;
  return h;
}

/** The view as a pinhole camera: the eye in ECEF and the screen point of a direction from it (undefined behind). */
export interface SkyCamera {
  readonly eye: readonly number[];
  project(dir: readonly number[]): { x: number; y: number } | undefined;
  /** The direction from the eye through a screen point (not normalized). */
  ray(x: number, y: number): number[];
}

/**
 * Fits the camera from ground points: for a pinhole camera at the eye, a screen point is (h1·d / h3·d, h2·d / h3·d) for
 * the direction d from the eye, with h1–h3 the rows of a 3 × 3 matrix found by least squares (one entry fixed to 1).
 */
export async function skyCamera(page: Page): Promise<SkyCamera> {
  const camera = await page.evaluate(() => window.vibeglobePlayground?.globe.camera);
  if (!camera) throw new Error('no camera');
  const eye = geodeticToEcef(camera.eyeLongitudeDeg, camera.eyeLatitudeDeg, camera.altitudeMeters);
  const grid: { xPx: number; yPx: number }[] = [];
  for (let y = 60; y <= 180; y += 15) for (let x = 80; x <= 240; x += 20) grid.push({ xPx: x, yPx: y });
  const ground = await page.evaluate(
    (points) => points.map((p) => window.vibeglobePlayground?.globe.screenToGeo(p) ?? null),
    grid,
  );
  const pairs = grid.flatMap((screen, i) => {
    const g = ground[i];
    if (!g) return [];
    const p = geodeticToEcef(g.longitudeDeg, g.latitudeDeg, 0);
    return [{ screen, d: p.map((v, k) => v - (eye[k] ?? 0)) }];
  });
  if (pairs.length < 12) throw new Error(`only ${pairs.length} ground points to fit the camera`);
  const forward = pairs[Math.floor(pairs.length / 2)]?.d ?? [0, 0, -1];
  const h = fitProjective(pairs, forward);
  const dotRow = (r: number, d: readonly number[]): number =>
    (h[r * 3] ?? 0) * (d[0] ?? 0) + (h[r * 3 + 1] ?? 0) * (d[1] ?? 0) + (h[r * 3 + 2] ?? 0) * (d[2] ?? 0);
  // In front of the eye: the same sign of h3 · d as the ground points have.
  const front = Math.sign(dotRow(2, forward));
  const project = (d: readonly number[]): { x: number; y: number } | undefined => {
    const w = dotRow(2, d);
    return w * front <= 0 ? undefined : { x: dotRow(0, d) / w, y: dotRow(1, d) / w };
  };
  const residual = Math.max(
    ...pairs.map(({ screen, d }) => {
      const p = project(d);
      return p ? Math.hypot(p.x - screen.xPx, p.y - screen.yPx) : Infinity;
    }),
  );
  if (residual > 0.05) throw new Error(`the pinhole fit misses a ground point by ${residual.toFixed(3)} px`);
  // The inverse matrix up to scale (the adjugate), its rays turned to point in front of the eye.
  const m = (r: number, c: number): number => h[r * 3 + c] ?? 0;
  const cof = (r: number, c: number): number =>
    m((c + 1) % 3, (r + 1) % 3) * m((c + 2) % 3, (r + 2) % 3) -
    m((c + 1) % 3, (r + 2) % 3) * m((c + 2) % 3, (r + 1) % 3);
  const ray = (x: number, y: number): number[] => {
    const d = [0, 1, 2].map((r) => cof(r, 0) * x + cof(r, 1) * y + cof(r, 2));
    return dotRow(2, d) * front < 0 ? d.map((v) => -v) : d;
  };
  return { eye, project, ray };
}

/** Whether the ray from `eye` along `dir` hits the ellipsoid (slightly enlarged): the star is behind the globe. */
export function behindGlobe(eye: readonly number[], dir: readonly number[]): boolean {
  const s = [1, 1, A / 6_356_752.314245];
  const o = eye.map((v, i) => (v * (s[i] ?? 1)) / (A + 30_000));
  const d = dir.map((v, i) => v * (s[i] ?? 1));
  const a = d.reduce((sum, v) => sum + v * v, 0);
  const b = 2 * d.reduce((sum, v, i) => sum + v * (o[i] ?? 0), 0);
  const c = o.reduce((sum, v) => sum + v * v, 0) - 1;
  return b * b - 4 * a * c > 0 && b < 0;
}

/** Linear-light luminance above the page's background of a pixel. */
export function luminance(image: PNG, x: number, y: number): number {
  const i = (y * image.width + x) * 4;
  return 0.2126 * (image.data[i] ?? 0) + 0.7152 * (image.data[i + 1] ?? 0) + 0.0722 * (image.data[i + 2] ?? 0);
}

/** Predicted screen positions of the catalog's stars brighter than `magnitude`, in view and not behind the globe. */
export async function predictStars(page: Page, magnitude: number, utcMs: number): Promise<{ x: number; y: number }[]> {
  const camera = await skyCamera(page);
  return catalogStars(magnitude).flatMap((star) => {
    const dir = starEcef(star.ra, star.dec, utcMs);
    const p = behindGlobe(camera.eye, dir) ? undefined : camera.project(dir);
    return p && p.x > 6 && p.y > 6 && p.x < 314 && p.y < 234 ? [p] : [];
  });
}

/** How many predicted stars are drawn: the brightest pixel within 2 px of the prediction stands out of its ring. */
export function starsFound(image: PNG, stars: readonly { x: number; y: number }[]): number {
  let found = 0;
  for (const { x, y } of stars) {
    let peak = 0;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) peak = Math.max(peak, luminance(image, Math.floor(x) + dx, Math.floor(y) + dy));
    let ring = 0;
    let count = 0;
    for (let dy = -6; dy <= 6; dy++)
      for (let dx = -6; dx <= 6; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 5) continue;
        ring += luminance(image, Math.floor(x) + dx, Math.floor(y) + dy);
        count++;
      }
    if (peak > ring / count + 25) found++;
  }
  return found;
}

/**
 * The stars' light in linear units, summed over the sky (where the frame without stars is black space, so the globe and
 * its loading imagery are left out), per CSS pixel.
 */
export function starLight(image: PNG, pixelRatio: number, background: PNG): number {
  let sum = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    if ((background.data[i] ?? 0) + (background.data[i + 1] ?? 0) + (background.data[i + 2] ?? 0) > 3) continue;
    for (let c = 0; c < 3; c++) {
      const linear = (v: number): number => (v / 255) ** 2.2;
      sum += Math.max(0, linear(image.data[i + c] ?? 0) - linear(background.data[i + c] ?? 0));
    }
  }
  return sum / (pixelRatio * pixelRatio);
}

/** The mean light of the top tenth of the frame: the sky above a tilted view's horizon. */
export function topLight(image: PNG): number {
  let sum = 0;
  const rows = Math.floor(image.height / 10);
  for (let y = 0; y < rows; y++) for (let x = 0; x < image.width; x++) sum += luminance(image, x, y);
  return sum / (rows * image.width);
}

/** Galactic axes in J2000 equatorial coordinates (Hipparcos, vol. 1, §1.5.3): rows x, y, z. */
export const GALACTIC = [
  [-0.0548755604, -0.8734370902, -0.4838350155],
  [0.4941094279, -0.44482963, 0.7469822445],
  [-0.867666149, -0.1980763734, 0.4559837762],
];
