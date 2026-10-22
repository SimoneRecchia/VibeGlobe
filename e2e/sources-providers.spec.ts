// The Google and OpenStreetMap provider profiles on the globe: a Google session that expires is renewed without a blank
// pixel (F257); the OpenStreetMap public servers see at most two requests at once during fast navigation, a Referer
// identifying the application on every request, and the page logs exactly one warning (F265–F267).
import { expect, test, type Page, type Route } from '@playwright/test';
import { GOOGLE_FIXTURE_KEY, googleFixture } from '../packages/sources/src/__fixtures__/google-server.ts';
import {
  expectCenterTileColor,
  expectNoEmptyPixels,
  mountSource,
  openSources,
  settledSourceFrame,
  sourceFrame,
  tilePng,
} from './support/sources.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST',
};

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

async function jump(page: Page, view: { longitudeDeg: number; latitudeDeg: number; zoom: number }): Promise<void> {
  await page.evaluate((v) => window.vibeglobeSources?.globe?.jumpTo(v), view);
}

test.describe('provider profiles on the globe', () => {
  // Several settled views on the container's software GPU.
  test.setTimeout(240_000);

  test('an expired Google session is renewed transparently with zero empty pixels (F257)', async ({ page }) => {
    const server = googleFixture(tilePng);
    await page.route('https://tile.googleapis.com/**', (route) => fulfillFrom(route, server.fetch));
    await openSources(page, 'lon=12.5&lat=41.9&zoom=3.4');
    await mountSource(
      page,
      `(s, key) => s.googleImagery({ id: 'google', apiKey: key, billingRegion: 'eea', mapType: 'roadmap' })`,
      GOOGLE_FIXTURE_KEY,
    );
    const first = await settledSourceFrame(page, 18);
    await expectCenterTileColor(page, first);
    server.expireSessions();
    await jump(page, { longitudeDeg: -74, latitudeDeg: 40.7, zoom: 4.2 });
    // While the session is renewed, the parents and the base keep every pixel covered.
    for (let i = 0; i < 3; i++) await expectNoEmptyPixels(page, await sourceFrame(page));
    const renewed = await settledSourceFrame(page, 18);
    await expectCenterTileColor(page, renewed);
    await expectNoEmptyPixels(page, renewed);
    const sessions = server.requests.filter((r) => r.url.includes('/v1/createSession'));
    expect(sessions.length).toBe(2);
    expect(
      server.requests.filter((r) => r.url.includes('/2dtiles/')).every((r) => /session=session-\d+&key=/.test(r.url)),
    ).toBe(true);
  });

  test('the OpenStreetMap public servers: two requests at most, the Referer on each, one warning (F265–F267)', async ({
    page,
  }) => {
    let inFlight = 0;
    let most = 0;
    const referers: string[] = [];
    await page.route('https://tile.openstreetmap.org/**', async (route) => {
      inFlight++;
      most = Math.max(most, inFlight);
      referers.push(route.request().headers()['referer'] ?? '');
      await new Promise((resolve) => setTimeout(resolve, 120));
      const [z = 0, x = 0, y = 0] =
        /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(route.request().url())?.slice(1).map(Number) ?? [];
      inFlight--;
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'max-age=86400' },
        body: Buffer.from(tilePng(z, x, y)),
      });
    });
    const warnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'warning' && message.text().includes('OpenStreetMap')) warnings.push(message.text());
    });
    await openSources(page, 'lon=12.5&lat=41.9&zoom=3');
    const origin = new URL(page.url()).origin;
    await mountSource(page, `(s, url) => s.openStreetMapImagery({ appName: 'VibeGlobe tests', appUrl: url })`, origin);
    // Fast pan, zoom and jumps across the world, without waiting for tiles.
    const views = [
      { longitudeDeg: 2.35, latitudeDeg: 48.85, zoom: 5 },
      { longitudeDeg: 13.4, latitudeDeg: 52.5, zoom: 6.5 },
      { longitudeDeg: -0.12, latitudeDeg: 51.5, zoom: 4 },
      { longitudeDeg: 139.7, latitudeDeg: 35.7, zoom: 5.5 },
      { longitudeDeg: -74, latitudeDeg: 40.7, zoom: 7 },
    ];
    for (const view of views) {
      await jump(page, view);
      await page.waitForTimeout(250);
      await expectNoEmptyPixels(page, await sourceFrame(page));
    }
    await expectNoEmptyPixels(page, await settledSourceFrame(page, 19));
    expect(referers.length).toBeGreaterThan(10);
    expect(most).toBeLessThanOrEqual(2);
    expect(referers.every((r) => r.startsWith(origin))).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/unsuitable for production/);
  });
});
