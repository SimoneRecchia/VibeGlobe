// 3D Tiles over the engine's terrain and imagery (F467): the fixture city's `terrain` variant lays its (purple) ground
// on the fixture terrain itself, the worst case for z-fighting. While orbiting at street level, and in a top-down
// screenshot, no pixel inside the city's footprint shows the terrain's imagery (its light green) through the tileset.
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, waitForIdle } from './support/globe.ts';
import { CITY, cityPoint, openCity, settleTiles } from './support/tiles3d.ts';

test.use({ viewport: { width: 320, height: 240 } });
test.setTimeout(180_000);

/** Canvas pixels (every third one) whose ground lies inside the city's footprint, inset by 24 m. */
async function footprintMask(page: Page): Promise<Set<number>> {
  const inside = await page.evaluate((city) => {
    const globe = window.vibeglobePlayground?.globe;
    const cos = Math.cos((city.latitudeDeg * Math.PI) / 180);
    const out: number[] = [];
    for (let y = 0; y < 240; y += 3)
      for (let x = 0; x < 320; x += 3) {
        const g = globe?.screenToGeo({ xPx: x, yPx: y });
        if (!g) continue;
        const east = (g.longitudeDeg - city.longitudeDeg) * 111_320 * cos;
        const north = (g.latitudeDeg - city.latitudeDeg) * 110_950;
        if (Math.abs(east) < city.halfMeters - 24 && Math.abs(north) < city.halfMeters - 24) out.push(y * 320 + x);
      }
    return out;
  }, CITY);
  return new Set(inside);
}

/** The terrain imagery's light green ('world' fixture pattern): neither the purple ground nor the beige buildings. */
const isImagery = (image: PNG, index: number): boolean => {
  const r = image.data[index * 4] ?? 0;
  const g = image.data[index * 4 + 1] ?? 0;
  const b = image.data[index * 4 + 2] ?? 0;
  return g > r + 30 && g >= b;
};

for (const backend of ['webgl2', 'webgpu'] as const)
  test(`orbiting at street level shows no terrain through the tileset (${backend}) (F467)`, async ({ page }) => {
    const at = cityPoint(0, -200);
    await openCity(
      page,
      `backend=${backend}&terrain=terrarium&tiles3d=terrain&lon=${at.longitudeDeg}&lat=${at.latitudeDeg}&zoom=17.5&tilt=70`,
    );
    await settleTiles(page);
    let checked = 0;
    const leaks: string[] = [];
    for (let heading = 0; heading < 360; heading += 45) {
      await page.evaluate(
        async (view) => {
          await window.vibeglobePlayground?.globe.jumpTo(view);
        },
        { longitudeDeg: at.longitudeDeg, latitudeDeg: at.latitudeDeg, zoom: 17.5, tiltDeg: 70, headingDeg: heading },
      );
      await settleTiles(page);
      await waitForIdle(page);
      const mask = await footprintMask(page);
      const image = await canvasImage(page);
      let leaked = 0;
      for (const index of mask) if (isImagery(image, index)) leaked++;
      checked += mask.size;
      if (leaked > 0) leaks.push(`heading ${heading}: ${leaked} of ${mask.size}`);
    }
    expect(checked).toBeGreaterThan(2000);
    expect(leaks).toEqual([]);
  });

test('a top-down screenshot over terrain shows the tileset, never the terrain, inside its footprint (F467)', async ({
  page,
}) => {
  await openCity(
    page,
    `backend=webgl2&terrain=terrarium&tiles3d=terrain&lon=${CITY.longitudeDeg}&lat=${CITY.latitudeDeg}&zoom=16&tilt=0`,
  );
  await settleTiles(page);
  const mask = await footprintMask(page);
  const image = await canvasImage(page);
  let leaked = 0;
  for (const index of mask) if (isImagery(image, index)) leaked++;
  expect(mask.size).toBeGreaterThan(4000);
  expect(leaked).toBe(0);
});
