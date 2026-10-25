// The space background (ADR 0181, F601–F608) through the playground's `?stars=1`: the stars stand where their celestial
// directions project for several camera poses and sky times, on both backends; their light is the same at pixel ratios
// 1 and 2 and steady under sub-pixel motion; the Milky Way follows the galactic plane; the background hides under the
// daytime sky near the ground; screenshots match their baselines. Predictions here are written independently of the
// engine: sidereal time and precession from Meeus's formulas (ch. 12 and 21, the first-order precession in right
// ascension and declination), projected through a pinhole camera fitted to the engine's public `screenToGeo` (a
// direction from the eye maps to the screen by a 3 × 3 projective matrix, found from ground points by least squares).
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { BACKGROUND_RGB, canvasImage, openGlobe, waitForIdle } from './support/globe.ts';
import { CROSS_BACKEND, compareImages, expectMatchesBaseline } from './support/visual.ts';

test.use({ viewport: { width: 320, height: 240 } });

const DEG = Math.PI / 180;
const A = 6_378_137;
const E2 = 0.00669437999014;
/** The playground's default sky time: the engine's fixed epoch (ADR 0181). */
const EPOCH_MS = Date.UTC(2026, 5, 21, 12);

/**
 * The catalog's stars brighter than a magnitude, decoded here from the data module's text (ADR 0181's encoding): right
 * ascension and declination in radians.
 */
function catalogStars(magnitude: number): { ra: number; dec: number }[] {
  const text = readFileSync(
    new URL('../packages/renderer/src/starfield/star-catalog-data.ts', import.meta.url),
    'utf8',
  );
  const bytes = Buffer.from(/STAR_CATALOG_BASE64 =\s*'([^']+)'/.exec(text)?.[1] ?? '', 'base64');
  const stars: { ra: number; dec: number }[] = [];
  for (let at = 0; at + 6 <= bytes.length && (bytes[at + 4] ?? 0) / 25 - 2 < magnitude; at += 6)
    stars.push({
      ra: (bytes.readUInt16LE(at) / 65_536) * 2 * Math.PI,
      dec: (bytes.readInt16LE(at + 2) / 32_767) * 90 * DEG,
    });
  return stars;
}

interface StarsHandle {
  visibility: number;
  skyTimeMs: number;
  setOptions(options: Record<string, unknown>): void;
  remove(): void;
}
type StarsWindow = Window & { vibeglobeStars?: StarsHandle };

async function openStars(page: Page, query: string): Promise<void> {
  await openGlobe(page, `stars=1&${query}`);
  await page.waitForFunction(() => ((window as StarsWindow).vibeglobeStars?.skyTimeMs ?? 0) > 0);
  await waitForIdle(page);
}

async function setStars(page: Page, options: Record<string, unknown>): Promise<void> {
  await page.evaluate((o) => (window as StarsWindow).vibeglobeStars?.setOptions(o), options);
  await waitForIdle(page);
}

/** Greenwich mean sidereal time, degrees (Meeus 12.4). */
function siderealDeg(utcMs: number): number {
  const d = utcMs / 86_400_000 + 2_440_587.5 - 2_451_545;
  const t = d / 36_525;
  return (((280.46061837 + 360.98564736629 * d + 0.000387933 * t * t) % 360) + 360) % 360;
}

/** The ECEF direction of a J2000 position at a time: first-order precession, then the Earth's rotation. */
function starEcef(raRad: number, decRad: number, utcMs: number): [number, number, number] {
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

/** The view as a pinhole camera: the eye in ECEF and the screen point of a direction from it (undefined behind). */
interface SkyCamera {
  readonly eye: readonly number[];
  project(dir: readonly number[]): { x: number; y: number } | undefined;
  /** The direction from the eye through a screen point (not normalized). */
  ray(x: number, y: number): number[];
}

/**
 * Fits the camera from ground points: for a pinhole camera at the eye, a screen point is (h1·d / h3·d, h2·d / h3·d) for
 * the direction d from the eye, with h1–h3 the rows of a 3 × 3 matrix found by least squares (one entry fixed to 1).
 */
async function skyCamera(page: Page): Promise<SkyCamera> {
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
function behindGlobe(eye: readonly number[], dir: readonly number[]): boolean {
  const s = [1, 1, A / 6_356_752.314245];
  const o = eye.map((v, i) => (v * (s[i] ?? 1)) / (A + 30_000));
  const d = dir.map((v, i) => v * (s[i] ?? 1));
  const a = d.reduce((sum, v) => sum + v * v, 0);
  const b = 2 * d.reduce((sum, v, i) => sum + v * (o[i] ?? 0), 0);
  const c = o.reduce((sum, v) => sum + v * v, 0) - 1;
  return b * b - 4 * a * c > 0 && b < 0;
}

/** Linear-light luminance above the page's background of a pixel. */
function luminance(image: PNG, x: number, y: number): number {
  const i = (y * image.width + x) * 4;
  return 0.2126 * (image.data[i] ?? 0) + 0.7152 * (image.data[i + 1] ?? 0) + 0.0722 * (image.data[i + 2] ?? 0);
}

/** Predicted screen positions of the catalog's stars brighter than `magnitude`, in view and not behind the globe. */
async function predictStars(page: Page, magnitude: number, utcMs: number): Promise<{ x: number; y: number }[]> {
  const camera = await skyCamera(page);
  return catalogStars(magnitude).flatMap((star) => {
    const dir = starEcef(star.ra, star.dec, utcMs);
    const p = behindGlobe(camera.eye, dir) ? undefined : camera.project(dir);
    return p && p.x > 6 && p.y > 6 && p.x < 314 && p.y < 234 ? [p] : [];
  });
}

/** How many predicted stars are drawn: the brightest pixel within 2 px of the prediction stands out of its ring. */
function starsFound(image: PNG, stars: readonly { x: number; y: number }[]): number {
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

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(`F603, F602: stars stand where their celestial directions project, for three poses and a later sky time, on ${backend}`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const poses = [
      'lon=0&lat=0&zoom=1.2',
      'lon=120&lat=40&zoom=2&heading=90&tilt=40',
      'lon=-70&lat=-30&zoom=0.8&heading=200&tilt=20',
    ];
    for (const pose of poses) {
      await openStars(page, `backend=${backend}&${pose}`);
      await setStars(page, { milkyWay: false });
      for (const timeMs of [EPOCH_MS, EPOCH_MS + 6 * 3_600_000]) {
        await page.evaluate((t) => window.vibeglobePlayground?.globe.setAtmosphere({ timeMs: t }), timeMs);
        await waitForIdle(page);
        const stars = await predictStars(page, 5, timeMs);
        const found = starsFound(await canvasImage(page), stars);
        console.log(`[starfield] ${backend} ${pose} +${(timeMs - EPOCH_MS) / 3.6e6} h: ${found}/${stars.length}`);
        expect(stars.length).toBeGreaterThanOrEqual(5);
        expect(found / stars.length).toBeGreaterThanOrEqual(0.9);
      }
    }
  });
}

/**
 * The stars' light in linear units, summed over the sky (where the frame without stars is black space, so the globe and
 * its loading imagery are left out), per CSS pixel.
 */
function starLight(image: PNG, pixelRatio: number, background: PNG): number {
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

test('F604: the stars are equally bright at pixel ratios 1 and 2, and steady under sub-pixel motion', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const light: number[] = [];
  for (const deviceScaleFactor of [1, 2]) {
    const context = await browser.newContext({ viewport: { width: 320, height: 240 }, deviceScaleFactor });
    const page = await context.newPage();
    await openStars(page, 'backend=webgpu&zoom=0.6');
    await setStars(page, { milkyWay: false, stars: false });
    const backdrop = await canvasImage(page);
    await setStars(page, { stars: true });
    light.push(starLight(await canvasImage(page), deviceScaleFactor, backdrop));
    if (deviceScaleFactor === 1) {
      // Turn the view by steps of a tenth of a pixel at the frame's edge: the total light holds within 3 %.
      const camera = await page.evaluate(() => window.vibeglobePlayground?.globe.camera);
      const steady: number[] = [];
      for (let step = 1; step <= 6; step++) {
        await page.evaluate(
          (heading) => window.vibeglobePlayground?.globe.jumpTo({ headingDeg: heading }),
          (camera?.headingDeg ?? 0) + step * 0.03,
        );
        await waitForIdle(page);
        steady.push(starLight(await canvasImage(page), 1, backdrop));
      }
      const mean = steady.reduce((a, b) => a + b, 0) / steady.length;
      console.log(`[starfield] F604 light under motion ${steady.map((v) => (v / mean).toFixed(4)).join(' ')}`);
      for (const value of steady) expect(Math.abs(value / mean - 1)).toBeLessThan(0.03);
    }
    await context.close();
  }
  console.log(`[starfield] F604 light per CSS px at ratios 1, 2: ${light.map((v) => v.toFixed(2)).join(', ')}`);
  expect((light[1] ?? 0) / (light[0] ?? 1)).toBeGreaterThan(0.75);
  expect((light[1] ?? 0) / (light[0] ?? 1)).toBeLessThan(1.25);
});

test('F605: the Milky Way is brighter within 6° of the galactic plane than beyond 25°', async ({ page }) => {
  test.setTimeout(120_000);
  await openStars(page, 'backend=webgpu&zoom=0.6');
  await setStars(page, { stars: false });
  const image = await canvasImage(page);
  const camera = await skyCamera(page);
  // Galactic axes in J2000 equatorial coordinates (Hipparcos, vol. 1, §1.5.3): rows x, y, z.
  const g = [
    [-0.0548755604, -0.8734370902, -0.4838350155],
    [0.4941094279, -0.44482963, 0.7469822445],
    [-0.867666149, -0.1980763734, 0.4559837762],
  ];
  // Every fourth pixel of the sky by its galactic latitude: the direction through it, back to J2000 axes, then galactic.
  const plane: number[] = [];
  const off: number[] = [];
  for (let y = 2; y < 238; y += 4)
    for (let x = 2; x < 318; x += 4) {
      const dir = camera.ray(x + 0.5, y + 0.5);
      if (behindGlobe(camera.eye, dir)) continue;
      const length = Math.hypot(dir[0] ?? 0, dir[1] ?? 0, dir[2] ?? 0);
      // Undo the Earth's rotation; precession over 26 years (0.4°) is negligible against the 8° bands compared.
      const hour = Math.atan2(dir[1] ?? 0, dir[0] ?? 0) + siderealDeg(EPOCH_MS) * DEG;
      const dec = Math.asin((dir[2] ?? 0) / length);
      const eq = [Math.cos(dec) * Math.cos(hour), Math.cos(dec) * Math.sin(hour), Math.sin(dec)];
      const b = Math.asin(eq.reduce((sum, v, k) => sum + v * (g[2]?.[k] ?? 0), 0)) / DEG;
      const value = luminance(image, x, y);
      if (Math.abs(b) < 6) plane.push(value);
      else if (Math.abs(b) > 25) off.push(value);
    }
  const mean = (values: number[]): number => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
  console.log(
    `[starfield] F605 plane ${mean(plane).toFixed(1)} (${plane.length}), 25° off ${mean(off).toFixed(1)} (${off.length})`,
  );
  expect(plane.length).toBeGreaterThanOrEqual(50);
  expect(off.length).toBeGreaterThanOrEqual(50);
  expect(mean(plane)).toBeGreaterThan(mean(off) + 4);
});

/** The mean light of the top tenth of the frame: the sky above a tilted view's horizon. */
function topLight(image: PNG): number {
  let sum = 0;
  const rows = Math.floor(image.height / 10);
  for (let y = 0; y < rows; y++) for (let x = 0; x < image.width; x++) sum += luminance(image, x, y);
  return sum / (rows * image.width);
}

test('F606: hidden under the daytime sky near the ground, shown at night and from space', async ({ page }) => {
  // Six page loads with the atmosphere drawn by the software GPU.
  test.setTimeout(300_000);
  const ground = 'backend=webgpu&imagery=world&lon=8&lat=46&zoom=9&tilt=80&atmosphere=high';
  const noon = '&sun=2026-06-21T12:00:00Z';
  const night = '&sun=2026-06-21T23:00:00Z';
  const frame = async (query: string, stars: boolean): Promise<PNG> => {
    if (stars) await openStars(page, query);
    else {
      await openGlobe(page, query);
      await waitForIdle(page);
    }
    // The quality page applies `?sun=` once the globe is ready.
    await page.waitForFunction(() => window.vibeglobePlayground?.globe.atmosphere.sunLighting === true);
    await waitForIdle(page);
    console.log(`[starfield] F606 captured ${stars ? 'with' : 'without'} ${query}`);
    return canvasImage(page);
  };
  const dayWithout = await frame(ground + noon, false);
  const dayWith = await frame(ground + noon, true);
  expect(await page.evaluate(() => (window as StarsWindow).vibeglobeStars?.visibility)).toBe(0);
  expect(compareImages(dayWithout, dayWith, 0.05).ratio).toBeLessThanOrEqual(0.0001);
  const nightWithout = topLight(await frame(ground + night, false));
  const nightWith = topLight(await frame(ground + night, true));
  expect(await page.evaluate(() => (window as StarsWindow).vibeglobeStars?.visibility)).toBe(1);
  const spaceWithout = topLight(await frame(`backend=webgpu&zoom=1&atmosphere=high${noon}`, false));
  const spaceWith = topLight(await frame(`backend=webgpu&zoom=1&atmosphere=high${noon}`, true));
  console.log(
    `[starfield] F606 night ${nightWithout.toFixed(2)} → ${nightWith.toFixed(2)}, space ${spaceWithout.toFixed(2)} → ${spaceWith.toFixed(2)}`,
  );
  expect(nightWith).toBeGreaterThan(nightWithout + 0.5);
  expect(spaceWith).not.toBe(spaceWithout);
});

test('F601, F607: off without ?stars=1; added, it draws behind the globe, and removed, the frame is as before', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openGlobe(page, 'backend=webgpu&zoom=1.2');
  await waitForIdle(page);
  expect(await page.evaluate(() => (window as StarsWindow).vibeglobeStars)).toBeUndefined();
  const without = await canvasImage(page);
  await openStars(page, 'backend=webgpu&zoom=1.2');
  const withStars = await canvasImage(page);
  // The background changes the sky, never the globe: the center pixel is the same.
  const center = (image: PNG): number => luminance(image, 160, 120);
  expect(center(withStars)).toBe(center(without));
  expect(compareImages(without, withStars, 0.05).ratio).toBeGreaterThan(0.05);
  await expect(
    page.evaluate(() => (window as StarsWindow).vibeglobeStars?.setOptions({ brightness: 9 })),
  ).rejects.toThrow(/brightness must be 0 to 8/);
  await page.evaluate(() => (window as StarsWindow).vibeglobeStars?.remove());
  await waitForIdle(page);
  expect(compareImages(without, await canvasImage(page), 0.05).ratio).toBe(0);
});

for (const backend of ['webgpu', 'webgl2'] as const)
  test(`F608: the space background matches its baseline on ${backend} @baseline`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await openStars(page, `backend=${backend}&lon=30&lat=20&zoom=1.4&heading=30&tilt=30`);
    const image = await canvasImage(page);
    await expectMatchesBaseline(page, testInfo, `starfield-${backend}.png`, image);
    if (backend === 'webgl2') {
      // The sky of both backends agrees: the globe and 2 px around its limb (the backends' own edge anti-aliasing,
      // contrasted against black space) are left out, found where the frame without the background is not the page.
      await openStars(page, 'backend=webgpu&lon=30&lat=20&zoom=1.4&heading=30&tilt=30');
      const other = compareImages(await canvasImage(page), image, CROSS_BACKEND.threshold);
      await setStars(page, { visible: false });
      const globe = await canvasImage(page);
      const isGlobe = (x: number, y: number): boolean => {
        const i = (y * globe.width + x) * 4;
        return [0, 1, 2].some((c) => Math.abs((globe.data[i + c] ?? 0) - (BACKGROUND_RGB[c] ?? 0)) > 2);
      };
      let sky = 0;
      let differing = 0;
      for (let y = 0; y < globe.height; y++)
        for (let x = 0; x < globe.width; x++) {
          let near = false;
          for (let dy = -2; dy <= 2 && !near; dy++)
            for (let dx = -2; dx <= 2 && !near; dx++) {
              const nx = Math.min(globe.width - 1, Math.max(0, x + dx));
              const ny = Math.min(globe.height - 1, Math.max(0, y + dy));
              near = isGlobe(nx, ny);
            }
          if (near) continue;
          sky++;
          const i = (y * globe.width + x) * 4;
          // pixelmatch paints differing pixels pure red.
          if (other.diff.data[i] === 255 && other.diff.data[i + 1] === 0 && other.diff.data[i + 2] === 0) differing++;
        }
      if (differing / sky > CROSS_BACKEND.maxDiffRatio)
        writeFileSync(testInfo.outputPath('cross-backend-diff.png'), PNG.sync.write(other.diff));
      console.log(`[starfield] F608 sky pixels ${sky}, differing ${differing}`);
      expect(sky).toBeGreaterThan(10_000);
      expect(differing / sky).toBeLessThanOrEqual(CROSS_BACKEND.maxDiffRatio);
    }
  });
