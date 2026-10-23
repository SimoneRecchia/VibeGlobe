// F447: style layer order, minzoom, maxzoom and visibility. Three fills of one park polygon, red under green
// (minzoom 13) under blue (maxzoom 12): the top visible layer's color shows; crossing a zoom limit or toggling
// visibility cross-fades over frames instead of popping, and never downloads a tile again.
import { expect, test, type Page } from '@playwright/test';
import { capture, near, openVector, rgbAt, settle } from './support.ts';

test.use({ viewport: { width: 320, height: 240 } });

const PARK = { longitudeDeg: 9.176, latitudeDeg: 45.473 };
const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];

async function parkColor(page: Page): Promise<number[]> {
  const p = await page.evaluate((g) => window.vibeglobePlayground?.globe.geoToScreen(g), PARK);
  if (p === undefined) throw new Error('park off screen');
  return rgbAt(await capture(page), p.xPx, p.yPx);
}

const jump = (page: Page, zoom: number) =>
  page.evaluate((v) => window.vibeglobePlayground?.globe.jumpTo(v), { ...PARK, zoom });

/** Colors of the park over successive frames, until it settles. */
async function frames(page: Page, count: number): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < count; i++) out.push(await parkColor(page));
  return out;
}

const between = (c: readonly number[], a: readonly number[], b: readonly number[]) =>
  !near(c, a, 20) &&
  !near(c, b, 20) &&
  c.every((v, i) => v >= Math.min(a[i] ?? 0, b[i] ?? 0) - 20 && v <= Math.max(a[i] ?? 0, b[i] ?? 0) + 20);

test('layers draw in style order within their zoom range (F447)', async ({ page }) => {
  await openVector(page, `vectorStyle=order&backend=webgl2&zoom=11.5&lon=${PARK.longitudeDeg}&lat=${PARK.latitudeDeg}`);
  expect(near(await parkColor(page), BLUE, 12)).toBe(true);
  await jump(page, 12.5);
  await settle(page);
  expect(near(await parkColor(page), RED, 12)).toBe(true);
  await jump(page, 13.5);
  await settle(page);
  expect(near(await parkColor(page), GREEN, 12)).toBe(true);
});

test('crossing minzoom and maxzoom cross-fades over frames (F447)', async ({ page }) => {
  await openVector(page, `vectorStyle=order&backend=webgl2&zoom=12.9&lon=${PARK.longitudeDeg}&lat=${PARK.latitudeDeg}`);
  expect(near(await parkColor(page), RED, 12)).toBe(true);
  // Across minzoom 13: green fades in over red.
  await jump(page, 13.1);
  const fadeIn = await frames(page, 12);
  expect(
    fadeIn.some((c) => between(c, RED, GREEN)),
    JSON.stringify(fadeIn),
  ).toBe(true);
  expect(near(fadeIn.at(-1) ?? [], GREEN, 12)).toBe(true);
  // Across maxzoom 12: blue fades in on the way back.
  await jump(page, 11.9);
  const fadeBlue = await frames(page, 12);
  expect(
    fadeBlue.some((c) => between(c, RED, BLUE) || between(c, GREEN, BLUE)),
    JSON.stringify(fadeBlue),
  ).toBe(true);
  expect(near(fadeBlue.at(-1) ?? [], BLUE, 12)).toBe(true);
});

test('visibility toggles at runtime fade and reload no tile (F447)', async ({ page }) => {
  await openVector(page, `vectorStyle=order&backend=webgl2&zoom=13.5&lon=${PARK.longitudeDeg}&lat=${PARK.latitudeDeg}`);
  const requested = await page.evaluate(() => window.vibeglobeVectorTiles?.layer?.requestLog().length);
  await page.evaluate(() => window.vibeglobeVectorTiles?.layer?.style.setVisibility('park-green', false));
  const hiding = await frames(page, 12);
  expect(hiding.some((c) => between(c, GREEN, RED))).toBe(true);
  expect(near(hiding.at(-1) ?? [], RED, 12)).toBe(true);
  await page.evaluate(() => window.vibeglobeVectorTiles?.layer?.style.setVisibility('park-green', true));
  await settle(page);
  expect(near(await parkColor(page), GREEN, 12)).toBe(true);
  expect(await page.evaluate(() => window.vibeglobeVectorTiles?.layer?.requestLog().length)).toBe(requested);
});
