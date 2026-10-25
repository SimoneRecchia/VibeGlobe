// The space background's motion and integration (ADR 0181), through the playground's `?stars=1`: nothing of it loads
// before it is switched on, it toggles at runtime, stars track their catalog directions to 0.5 px in every frame of an
// orbit, a tilt and a zoom, keep their brightness through a slow orbit, the Milky Way has no seam, pole pinch or
// banding, the background never draws over the globe and fades without a pop from space to the street and onto the
// flat map, its catalog comes from the configured URL, and the guide documents it. Predictions are independent of the
// engine (`support/starfield.ts`).
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { BACKGROUND_RGB, canvasImage, nextFrame, openGlobe, waitForIdle } from './support/globe.ts';
import {
  DEG,
  EPOCH_MS,
  GALACTIC,
  type SkyCamera,
  type StarsWindow,
  behindGlobe,
  catalogStars,
  luminance,
  openStars,
  setStars,
  siderealDeg,
  skyCamera,
  starEcef,
} from './support/starfield.ts';

test.use({ viewport: { width: 320, height: 240 } });

const W = 320;
const H = 240;

/** Linear light of a pixel, summed over its channels. */
function light(image: PNG, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return 0;
  const i = (y * image.width + x) * 4;
  let sum = 0;
  for (let c = 0; c < 3; c++) sum += ((image.data[i + c] ?? 0) / 255) ** 2.2;
  return sum;
}

/** Pixels of the globe (and 3 px around it): those not black space in a frame drawn with the stars off. */
function globeMask(backdrop: PNG): Uint8Array {
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if ((backdrop.data[i] ?? 0) + (backdrop.data[i + 1] ?? 0) + (backdrop.data[i + 2] ?? 0) <= 6) continue;
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < W && ny < H) mask[ny * W + nx] = 1;
        }
    }
  return mask;
}

/** The light-weighted centroid of a star in the 7 × 7 px around a prediction, and its light above the background. */
function measureStar(image: PNG, px: number, py: number): { x: number; y: number; light: number } {
  const cx = Math.floor(px);
  const cy = Math.floor(py);
  let ring = 0;
  let ringCount = 0;
  for (let dy = -5; dy <= 5; dy++)
    for (let dx = -5; dx <= 5; dx++)
      if (Math.max(Math.abs(dx), Math.abs(dy)) >= 4) {
        ring += light(image, cx + dx, cy + dy);
        ringCount++;
      }
  const background = ring / ringCount;
  let sum = 0;
  let sx = 0;
  let sy = 0;
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) {
      const value = Math.max(0, light(image, cx + dx, cy + dy) - background);
      sum += value;
      // Pixel centers sit half a pixel inside their corner (screen points are continuous CSS pixels).
      sx += value * (cx + dx + 0.5);
      sy += value * (cy + dy + 0.5);
    }
  return sum > 0 ? { x: sx / sum, y: sy / sum, light: sum } : { x: Number.NaN, y: Number.NaN, light: 0 };
}

/**
 * Catalog stars brighter than `magnitude` in view, clear of the globe and the frame's edge, with no other catalog star
 * to `neighborMagnitude` within `clearPx`: their light would pull the centroid or the sum.
 */
function isolatedStars(
  camera: SkyCamera,
  mask: Uint8Array,
  magnitude: number,
  utcMs: number,
  { clearPx = 6, neighborMagnitude = 6.5 } = {},
): { index: number; x: number; y: number }[] {
  const all = catalogStars(neighborMagnitude).map((star, index) => {
    const dir = starEcef(star.ra, star.dec, utcMs);
    const p = behindGlobe(camera.eye, dir) ? undefined : camera.project(dir);
    return { index, p, bright: star.magnitude < magnitude };
  });
  const shown = all.filter((s) => s.p && s.p.x > -10 && s.p.y > -10 && s.p.x < W + 10 && s.p.y < H + 10);
  return shown.flatMap(({ index, p, bright }) => {
    if (!p || !bright || p.x < clearPx || p.y < clearPx || p.x > W - clearPx || p.y > H - clearPx) return [];
    for (let dy = -clearPx; dy <= clearPx; dy++)
      for (let dx = -clearPx; dx <= clearPx; dx++)
        if (mask[(Math.floor(p.y) + dy) * W + Math.floor(p.x) + dx]) return [];
    const crowded = shown.some((o) => o.index !== index && o.p && Math.hypot(o.p.x - p.x, o.p.y - p.y) < clearPx);
    return crowded ? [] : [{ index, x: p.x, y: p.y }];
  });
}

/** Moves the camera, then captures the frame with the stars off (the globe's mask) and on. */
async function poseFrames(
  page: Page,
  view: Record<string, number>,
): Promise<{ camera: SkyCamera; mask: Uint8Array; image: PNG }> {
  await page.evaluate((v) => window.vibeglobePlayground?.globe.jumpTo(v), view);
  await setStars(page, { stars: false });
  const mask = globeMask(await canvasImage(page));
  await setStars(page, { stars: true });
  return { camera: await skyCamera(page), mask, image: await canvasImage(page) };
}

test('F600: nothing loads before the background is switched on; it toggles at runtime in the next frame', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const requested: string[] = [];
  page.on('request', (request) => requested.push(new URL(request.url()).pathname));
  await openGlobe(page, 'backend=webgpu&zoom=0.8');
  await waitForIdle(page);
  expect(requested.filter((path) => /starfield|bsc5-stars/.test(path))).toEqual([]);
  const without = await canvasImage(page);
  await openStars(page, 'backend=webgpu&zoom=0.8');
  expect(requested.filter((path) => path.endsWith('bsc5-stars.bin'))).toHaveLength(1);
  for (const visible of [false, true, false]) {
    await page.evaluate((v) => (window as StarsWindow).vibeglobeStars?.setOptions({ visible: v }), visible);
    await nextFrame(page);
    const frame = await canvasImage(page);
    const differ = (a: PNG, b: PNG): number => {
      let count = 0;
      for (let i = 0; i < a.data.length; i += 4) if (a.data[i] !== b.data[i]) count++;
      return count;
    };
    if (visible) expect(differ(frame, without)).toBeGreaterThan(1000);
    else expect(differ(frame, without)).toBe(0);
  }
});

test('F600: the background is a render extension of the renderer package; core does not depend on it', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const core = new URL('../packages/core/', import.meta.url);
  const sources = (readdirSync(new URL('src/', core), { recursive: true }) as string[]).filter((f) =>
    f.endsWith('.ts'),
  );
  for (const file of sources)
    expect(readFileSync(new URL(`src/${file}`, core), 'utf8'), file).not.toMatch(/starfield|addSpaceBackground/);
  const renderer = JSON.parse(readFileSync(new URL('../packages/renderer/package.json', import.meta.url), 'utf8')) as {
    exports: Record<string, { source: string }>;
  };
  expect(renderer.exports['./starfield']?.source).toBe('./src/starfield/index.ts');
  const helper = readFileSync(
    new URL('../packages/renderer/src/starfield/space-background.ts', import.meta.url),
    'utf8',
  );
  expect(helper).toContain('globe.addRenderExtension(');
});

for (const backend of ['webgpu', 'webgl2'] as const)
  test(`F601: through an orbit, a tilt and a zoom, every tracked star stays within 0.5 px of its catalog direction, on ${backend}`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openStars(page, `backend=${backend}&lon=40&lat=10&zoom=0`);
    await setStars(page, { milkyWay: false });
    const views = [
      ...[0, 6, 12, 18, 24, 30].map((headingDeg) => ({ headingDeg, tiltDeg: 0, zoom: 0 })),
      ...[5, 10, 15, 20].map((tiltDeg) => ({ headingDeg: 30, tiltDeg, zoom: 0 })),
      ...[0.1, 0.2, 0.3, 0.4].map((zoom) => ({ headingDeg: 30, tiltDeg: 20, zoom })),
    ];
    let tracked = 0;
    let worst = 0;
    for (const view of views) {
      const { camera, mask, image } = await poseFrames(page, view);
      const stars = isolatedStars(camera, mask, 4.5, EPOCH_MS);
      expect(stars.length, JSON.stringify(view)).toBeGreaterThanOrEqual(3);
      for (const star of stars) {
        const seen = measureStar(image, star.x, star.y);
        const error = Math.hypot(seen.x - star.x, seen.y - star.y);
        worst = Math.max(worst, error);
        tracked++;
        expect(error, `star ${star.index} at ${JSON.stringify(view)}`).toBeLessThanOrEqual(0.5);
      }
    }
    console.log(
      `[starfield] F601 ${backend}: ${tracked} star positions over ${views.length} frames, worst ${worst.toFixed(3)} px`,
    );
  });

test('F602: through a slow orbit no star brightens or dims by more than 10 % from one frame to the next', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openStars(page, 'backend=webgpu&lon=-30&lat=-20&zoom=0');
  await setStars(page, { milkyWay: false });
  let previous = new Map<number, number>();
  let worst = 0;
  let compared = 0;
  for (let step = 0; step < 12; step++) {
    // 0.15° a frame: the stars at the frame's edge move about half a pixel.
    const { camera, mask, image } = await poseFrames(page, { headingDeg: step * 0.15, tiltDeg: 0, zoom: 0 });
    const current = new Map<number, number>();
    for (const star of isolatedStars(camera, mask, 5, EPOCH_MS, { clearPx: 8, neighborMagnitude: 8 })) {
      const seen = measureStar(image, star.x, star.y).light;
      current.set(star.index, seen);
      const before = previous.get(star.index);
      if (before === undefined) continue;
      compared++;
      worst = Math.max(worst, Math.abs(seen / before - 1));
    }
    previous = current;
  }
  console.log(`[starfield] F602 flicker: ${compared} comparisons, worst ${(worst * 100).toFixed(2)} %`);
  expect(compared).toBeGreaterThanOrEqual(50);
  expect(worst).toBeLessThan(0.1);
});

/** The ECEF direction of a galactic longitude and latitude at the playground's sky time. */
function galacticEcef(lDeg: number, bDeg: number): [number, number, number] {
  const gal = [
    Math.cos(bDeg * DEG) * Math.cos(lDeg * DEG),
    Math.cos(bDeg * DEG) * Math.sin(lDeg * DEG),
    Math.sin(bDeg * DEG),
  ];
  const eq = [0, 1, 2].map((k) => GALACTIC.reduce((sum, row, r) => sum + (row[k] ?? 0) * (gal[r] ?? 0), 0));
  return starEcef(Math.atan2(eq[1] ?? 0, eq[0] ?? 0), Math.asin(eq[2] ?? 0), EPOCH_MS);
}

/** The galactic longitude and latitude of an ECEF direction at the playground's sky time, degrees. */
function galacticOf(dir: readonly number[]): { l: number; b: number } {
  const length = Math.hypot(dir[0] ?? 0, dir[1] ?? 0, dir[2] ?? 0);
  // Back to J2000 axes; the 26 years of precession (0.4°) are negligible for the bands compared here.
  const hour = Math.atan2(dir[1] ?? 0, dir[0] ?? 0) + siderealDeg(EPOCH_MS) * DEG;
  const dec = Math.asin((dir[2] ?? 0) / length);
  const eq = [Math.cos(dec) * Math.cos(hour), Math.cos(dec) * Math.sin(hour), Math.sin(dec)];
  const g = GALACTIC.map((row) => row.reduce((sum, v, k) => sum + v * (eq[k] ?? 0), 0));
  return { l: Math.atan2(g[1] ?? 0, g[0] ?? 0) / DEG, b: Math.asin(g[2] ?? 0) / DEG };
}

/** Sky-pixel luminance in 8-bit levels, or NaN on the globe. */
function skyLevel(image: PNG, mask: Uint8Array, x: number, y: number): number {
  return mask[y * W + x] ? Number.NaN : luminance(image, x, y);
}

test('F603: the Milky Way shows no seam at the galactic anticenter, no pinch at its poles and no banding', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openStars(page, 'backend=webgpu&zoom=0');
  await setStars(page, { stars: false });
  let seamPairs = 0;
  let worstSeam = 0;
  const polePixels = { north: 0, south: 0 };
  let worstPole = 0;
  let worstStep = 0;
  for (const [name, l, b] of [
    ['anticenter', 180, 0],
    ['north pole', 0, 90],
    ['south pole', 0, -90],
    ['center', 0, 0],
  ] as const) {
    // Look across the globe's limb toward the direction: the camera stands opposite it, moved aside until the
    // direction is in the frame and clear of the globe.
    const toward = galacticEcef(l, b);
    const lon = Math.atan2(-(toward[1] ?? 0), -(toward[0] ?? 0)) / DEG;
    const opposite = Math.asin(-(toward[2] ?? 0)) / DEG;
    let camera: SkyCamera | undefined;
    for (const aside of [12, 13, 14, 15, 16, 17]) {
      const lat = opposite > 0 ? opposite - aside : opposite + aside;
      await page.evaluate(
        ([lo, la]) => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: lo, latitudeDeg: la }),
        [lon, lat] as const,
      );
      await waitForIdle(page);
      const candidate = await skyCamera(page);
      const p = candidate.project(toward);
      if (p && p.x > 12 && p.y > 12 && p.x < W - 12 && p.y < H - 12 && !behindGlobe(candidate.eye, toward)) {
        camera = candidate;
        break;
      }
    }
    if (!camera) throw new Error(`no view shows the ${name}`);
    const image = await canvasImage(page);
    // The globe from the camera: rays that hit the ellipsoid.
    const mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        for (const [dx, dy] of [
          [-3, 0],
          [3, 0],
          [0, -3],
          [0, 3],
          [0, 0],
        ] as const)
          if (behindGlobe(camera.eye, camera.ray(x + 0.5 + dx, y + 0.5 + dy))) mask[y * W + x] = 1;
    for (let y = 0; y < H - 1; y++)
      for (let x = 0; x < W - 1; x++) {
        const here = skyLevel(image, mask, x, y);
        const right = skyLevel(image, mask, x + 1, y);
        const below = skyLevel(image, mask, x, y + 1);
        if (Number.isNaN(here)) continue;
        const step = Math.max(Math.abs(here - right) || 0, Math.abs(here - below) || 0);
        worstStep = Math.max(worstStep, step);
        const g = galacticOf(camera.ray(x + 0.5, y + 0.5));
        const gr = galacticOf(camera.ray(x + 1.5, y + 0.5));
        if (!Number.isNaN(right) && Math.abs(g.l) > 170 && Math.sign(g.l) !== Math.sign(gr.l)) {
          seamPairs++;
          worstSeam = Math.max(worstSeam, Math.abs(here - right));
        }
        if (Math.abs(g.b) > 87) {
          polePixels[g.b > 0 ? 'north' : 'south']++;
          worstPole = Math.max(worstPole, step);
        }
      }
    console.log(`[starfield] F603 ${name}: seam pairs ${seamPairs}, pole pixels ${JSON.stringify(polePixels)}`);
  }
  console.log(
    `[starfield] F603 worst steps: seam ${worstSeam.toFixed(2)}, pole ${worstPole.toFixed(2)}, anywhere ${worstStep.toFixed(2)}`,
  );
  expect(seamPairs).toBeGreaterThanOrEqual(20);
  expect(polePixels.north).toBeGreaterThanOrEqual(20);
  expect(polePixels.south).toBeGreaterThanOrEqual(20);
  // In 8-bit levels: a seam or a pinch would be a step across the line; banding, a step of several levels where the
  // light varies smoothly (the clumps' steepest gradient is 4 levels a pixel at this scale).
  expect(worstSeam).toBeLessThanOrEqual(2);
  expect(worstPole).toBeLessThanOrEqual(2);
  expect(worstStep).toBeLessThanOrEqual(6);
});

test('F604: no background pixel inside the globe; a zoom from space to the street fades it without a pop or a hole', async ({
  page,
}) => {
  test.setTimeout(300_000);
  // Inside the globe's disc the frame is the same with the background on and off.
  await openStars(page, 'backend=webgpu&zoom=0.8');
  const on = await canvasImage(page);
  await setStars(page, { visible: false });
  const off = await canvasImage(page);
  let disc = 0;
  let changed = 0;
  for (let y = 3; y < H - 3; y++)
    for (let x = 3; x < W - 3; x++) {
      let inside = true;
      for (const [dx, dy] of [
        [-3, 0],
        [3, 0],
        [0, -3],
        [0, 3],
      ] as const) {
        const i = ((y + dy) * W + x + dx) * 4;
        if ([0, 1, 2].every((c) => Math.abs((off.data[i + c] ?? 0) - (BACKGROUND_RGB[c] ?? 0)) <= 2)) inside = false;
      }
      if (!inside) continue;
      disc++;
      const i = (y * W + x) * 4;
      if ([0, 1, 2].some((c) => on.data[i + c] !== off.data[i + c])) changed++;
    }
  expect(disc).toBeGreaterThan(10_000);
  expect(changed).toBe(0);
  // Down to the street with the atmosphere's day sky, frame-stepped: the opacity falls smoothly to 0, no hole, no black.
  await openStars(page, 'backend=webgpu&clockStepMs=16.666666666666668&atmosphere=high');
  await page.evaluate(() => {
    const record: number[] = [];
    Object.assign(window, { starVisibility: record });
    window.vibeglobePlayground?.globe.on('frame', () =>
      record.push((window as StarsWindow).vibeglobeStars?.visibility ?? -1),
    );
  });
  const report = await page.evaluate(() =>
    window.vibeglobePlayground?.recordScenario('zoom-globe-to-street-relief', 8),
  );
  const opacity = await page.evaluate(() => (window as unknown as { starVisibility: number[] }).starVisibility);
  let largest = 0;
  for (let i = 1; i < opacity.length; i++)
    largest = Math.max(largest, Math.abs((opacity[i] ?? 0) - (opacity[i - 1] ?? 0)));
  console.log(
    `[starfield] F604 ${opacity.length} frames, opacity ${opacity[0]?.toFixed(2)} → ${opacity.at(-1)?.toFixed(2)}, largest step ${largest.toFixed(3)}, holes ${report?.holes}, dark ${report?.dark}`,
  );
  expect(opacity[0]).toBeGreaterThan(0.95);
  expect(opacity.at(-1)).toBe(0);
  expect(largest).toBeLessThanOrEqual(0.1);
  expect(report?.holes).toBe(0);
  expect(report?.dark).toBe(0);
});

test('F605: the catalog is requested once, only when switched on, from the URL the application configures', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { readFileSync } = await import('node:fs');
  const catalog = readFileSync(new URL('../packages/renderer/src/starfield/bsc5-stars.bin', import.meta.url));
  const requested: string[] = [];
  await page.route(
    (url) => url.pathname.startsWith('/space-assets/'),
    (route) => route.fulfill({ body: catalog, contentType: 'application/octet-stream' }),
  );
  page.on('request', (request) => requested.push(new URL(request.url()).pathname));
  await openStars(page, 'backend=webgpu&zoom=0.8&starCatalog=/space-assets/stars.bin');
  expect(requested.filter((path) => /bsc5-stars|space-assets/.test(path))).toEqual(['/space-assets/stars.bin']);
  expect(await page.evaluate(() => (window as StarsWindow).vibeglobeStars?.visibility)).toBe(1);
});

test('F606: the guide documents enabling the background, its options and its asset hosting', async ({ page }) => {
  await page.goto(`http://localhost:${process.env['DOCS_PORT'] ?? 5174}/documents/Space_background.html`);
  await expect(page.getByRole('heading', { name: 'Space background', level: 1 })).toBeVisible();
  for (const section of ['Enabling it', 'Options', 'How it moves and fades', 'Hosting its asset'])
    await expect(page.getByRole('heading', { level: 2, name: section })).toBeVisible();
  await expect(page.getByText('catalogUrl').first()).toBeVisible();
});
