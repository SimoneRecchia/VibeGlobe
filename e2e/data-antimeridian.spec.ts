// Features across the antimeridian and around the poles (M10, F368): a line, a polygon, a circle and a label across
// ±180°, a polygon ring around the north pole and a circle containing the south pole, in the globe, 2D and tilted
// phases: drawn on their own side of the world, without a gap at ±180° or a collapse at a pole.
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, openGlobe, waitForIdle } from './support/globe.ts';

test.use({ viewport: { width: 480, height: 360 } });

const BACKENDS = ['webgpu', 'webgl2'] as const;

type Rgb = [number, number, number];
const lime = ([r, g, b]: Rgb): boolean => g > 180 && r < 150 && b < 100;
const orange = ([r, g, b]: Rgb): boolean => r > 200 && g > 90 && g < 180 && b < 80;
const cyan = ([r, g, b]: Rgb): boolean => b > 180 && g > 180 && r < 120;
const magenta = ([r, g, b]: Rgb): boolean => r > 180 && b > 180 && g < 100;
const white = ([r, g, b]: Rgb): boolean => r > 220 && g > 220 && b > 220;

function near(image: PNG, xPx: number, yPx: number, radius: number, test: (c: Rgb) => boolean): boolean {
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      const x = Math.round(xPx) + dx;
      const y = Math.round(yPx) + dy;
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      const i = (y * image.width + x) * 4;
      if (test([image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0])) return true;
    }
  return false;
}

async function show(page: Page, mode: '2d' | '3d' | 'auto', view: Record<string, number>): Promise<PNG> {
  await page.evaluate(
    ({ mode, view }) => {
      const globe = window.vibeglobePlayground?.globe;
      globe?.setViewMode(mode);
      globe?.jumpTo(view);
    },
    { mode, view },
  );
  await page.waitForTimeout(500);
  await waitForIdle(page);
  return canvasImage(page);
}

async function screen(page: Page, lon: number, lat: number) {
  return page.evaluate(
    ([longitudeDeg, latitudeDeg]) =>
      window.vibeglobePlayground?.globe.geoToScreen({ longitudeDeg: longitudeDeg ?? 0, latitudeDeg: latitudeDeg ?? 0 }),
    [lon, lat],
  );
}

/** Each check: a position inside a feature and the feature's color. */
const ACROSS = [
  { name: 'line west of 180°', at: [175, 12.5], color: lime },
  { name: 'line at 180°', at: [180, 15], color: lime },
  { name: 'line east of 180°', at: [-175, 17.5], color: lime },
  { name: 'polygon west of 180°', at: [177, -15], color: orange },
  { name: 'polygon at 180°', at: [180, -15], color: orange },
  { name: 'polygon east of 180°', at: [-177, -15], color: orange },
  // Beyond the tilted view's reach (behind its horizon, or below it): checked in the globe and 2D views.
  { name: 'circle west of 180°', at: [178, 40], color: cyan, flatOnly: true },
  { name: 'circle east of 180°', at: [-178, 40], color: cyan, flatOnly: true },
  { name: 'label at 180°', at: [180, -32], color: white, flatOnly: true },
] as const;

for (const backend of BACKENDS) {
  test(`lines, polygons, circles and labels across the antimeridian and around the poles draw on their side of the world in every phase on ${backend} (F368)`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openGlobe(page, `backend=${backend}&scenario=data-antimeridian`);
    await page.waitForFunction(() => window.vibeglobeLayers !== undefined);
    for (const [phase, mode, view] of [
      ['globe', 'auto', { longitudeDeg: 180, latitudeDeg: 4, zoom: 1.7 }],
      ['2D', '2d', { longitudeDeg: 180, latitudeDeg: 5, zoom: 1.5 }],
      ['tilted', '3d', { longitudeDeg: 180, latitudeDeg: -8, zoom: 3, tiltDeg: 35 }],
    ] as const) {
      const image = await show(page, mode, view);
      for (const check of ACROSS) {
        if (phase === 'tilted' && 'flatOnly' in check) continue;
        const at = await screen(page, check.at[0], check.at[1]);
        if (!at || at.xPx < 0 || at.yPx < 0 || at.xPx > 480 || at.yPx > 360)
          throw new Error(`${phase}: ${check.name} off screen`);
        // The label's center falls between its letters: its glyphs are searched a little wider.
        const radius = check.name.startsWith('label') ? 10 : 2;
        expect(near(image, at.xPx, at.yPx, radius, check.color), `${phase}: ${check.name}`).toBe(true);
      }
    }
    // Around the north pole: the ring at 80° closes through the pole, filling the cap on every side of it.
    for (const [phase, mode, view, points] of [
      [
        'globe',
        'auto',
        { longitudeDeg: 0, latitudeDeg: 84, zoom: 0 },
        [
          [0, 84],
          [90, 86],
          [-90, 86],
          [180, 86],
          [45, 89.5],
        ],
      ],
      [
        '2D',
        '2d',
        // Far from the ring's first vertex (0°), across the antimeridian: the ring's world copies fill the cap.
        { longitudeDeg: 150, latitudeDeg: 82, zoom: 2.2 },
        [
          [150, 82],
          [170, 83],
          [130, 81],
          [-175, 82],
        ],
      ],
    ] as const) {
      const image = await show(page, mode, view);
      for (const [lon, lat] of points) {
        const at = await screen(page, lon, lat);
        if (!at || at.xPx < 0 || at.yPx < 0 || at.xPx > 480 || at.yPx > 360)
          throw new Error(`${phase}: ${lon}, ${lat} off screen`);
        expect(near(image, at.xPx, at.yPx, 1, magenta), `${phase}: north cap at ${lon}, ${lat}`).toBe(true);
      }
    }
    // The circle containing the south pole, seen from below the globe: covered on every side of the pole.
    const image = await show(page, 'auto', { longitudeDeg: 0, latitudeDeg: -84, zoom: 0 });
    for (const [lon, lat] of [
      [0, -88],
      [120, -88.5],
      [-120, -88.5],
    ] as const) {
      const at = await screen(page, lon, lat);
      if (!at || at.xPx < 0 || at.yPx < 0 || at.xPx > 480 || at.yPx > 360)
        throw new Error(`south cap ${lon}, ${lat} off screen`);
      expect(near(image, at.xPx, at.yPx, 1, cyan), `south cap at ${lon}, ${lat}`).toBe(true);
    }
  });
}
