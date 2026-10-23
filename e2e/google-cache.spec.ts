// Google tiles are reused from memory only while Google's cache headers allow it (F260, ADR 0031).
import { expect, test, type Page, type Route } from '@playwright/test';
import { GOOGLE_FIXTURE_KEY, googleFixture } from '../packages/sources/src/__fixtures__/google-server.ts';
import { expectNoEmptyPixels, mountSource, openSources, sourceFrame, tilePng } from './support/sources.ts';
import { waitForSourceIdle, waitForSourceImagery } from './support/sources.ts';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' };

/** Answers a routed request from a fixture `fetch`, adding CORS headers. */
async function fulfillFrom(route: Route, fixture: typeof fetch): Promise<void> {
  const request = route.request();
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  const body = request.postData();
  const response = await fixture(request.url(), { method: request.method(), ...(body === null ? {} : { body }) });
  return route.fulfill({
    status: response.status,
    headers: { ...Object.fromEntries(response.headers), ...CORS },
    body: Buffer.from(await response.arrayBuffer()),
  });
}

const ROME = { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 6 };
const NEW_YORK = { longitudeDeg: -74, latitudeDeg: 40.7, zoom: 6 };

async function settleAt(page: Page, view: typeof ROME): Promise<void> {
  await page.evaluate((v) => window.vibeglobeSources?.globe?.jumpTo(v), view);
  await waitForSourceImagery(page, 18);
  await waitForSourceIdle(page);
}

test('Google tiles are reused while their cache headers allow, and requested again once expired (F260)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const server = googleFixture(tilePng);
  server.maxAgeSeconds = 40;
  await page.route('https://tile.googleapis.com/**', (route) => fulfillFrom(route, server.fetch));
  await openSources(page, 'lon=12.5&lat=41.9&zoom=6');
  await mountSource(
    page,
    "(s, key) => s.googleImagery({ id: 'google', apiKey: key, billingRegion: 'eea', mapType: 'roadmap' })",
    GOOGLE_FIXTURE_KEY,
  );
  const tileRequests = (): string[] =>
    server.requests.map((r) => /\/v1\/2dtiles\/(\d+\/\d+\/\d+)/.exec(r.url)?.[1]).filter((t) => t !== undefined);
  await settleAt(page, ROME);
  const loadedAt = Date.now();
  const rome = new Set(tileRequests().filter((t) => Number(t.split('/')[0]) >= 5));
  expect(rome.size).toBeGreaterThan(0);
  // Away and back before the 40 s lifetime: Rome's tiles come from memory.
  await settleAt(page, NEW_YORK);
  let before = tileRequests().length;
  await settleAt(page, ROME);
  expect(Date.now() - loadedAt).toBeLessThan(40_000);
  expect(
    tileRequests()
      .slice(before)
      .filter((t) => rome.has(t)),
  ).toEqual([]);
  await expectNoEmptyPixels(page, await sourceFrame(page));
  // Away and back after it: the expired tiles are requested again, the view complete meanwhile.
  await settleAt(page, NEW_YORK);
  await page.waitForTimeout(Math.max(0, 41_000 - (Date.now() - loadedAt)));
  before = tileRequests().length;
  await page.evaluate((v) => window.vibeglobeSources?.globe?.jumpTo(v), ROME);
  for (let i = 0; i < 3; i++) await expectNoEmptyPixels(page, await sourceFrame(page));
  await waitForSourceImagery(page, 18);
  await waitForSourceIdle(page);
  expect(
    tileRequests()
      .slice(before)
      .filter((t) => rome.has(t)).length,
  ).toBeGreaterThan(0);
  await expectNoEmptyPixels(page, await sourceFrame(page));
});
