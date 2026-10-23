// Google's viewport credits (F258): once per settled view, the engine asks the Map Tiles API fixture for the copyright
// of the area shown and displays it with the Google credit, updated as the view moves to an area of other providers.
import { expect, test, type Page, type Route } from '@playwright/test';
import { GOOGLE_FIXTURE_KEY, googleFixture } from '../packages/sources/src/__fixtures__/google-server.ts';
import { mountSource, openSources, settledSourceFrame, tilePng } from './support/sources.ts';

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

/** The credits the mounted globe reports and the texts its attribution element shows. */
async function shownCredits(page: Page): Promise<{ reported: string[]; element: string }> {
  return page.evaluate(() => ({
    reported: (window.vibeglobeSources?.globe?.credits() ?? []).map((credit) => credit.text),
    element: document.querySelector('.vg-source-test .vg-credits')?.textContent ?? '',
  }));
}

test('Google viewport credits are asked once per settled view and follow the view (F258)', async ({ page }) => {
  test.setTimeout(180_000);
  const server = googleFixture(tilePng);
  await page.route('https://tile.googleapis.com/**', (route) => fulfillFrom(route, server.fetch));
  await openSources(page, 'lon=12.5&lat=41.9&zoom=6.5');
  await mountSource(
    page,
    `(s, key) => s.googleImagery({ id: 'google', apiKey: key, billingRegion: 'eea', mapType: 'roadmap' })`,
    GOOGLE_FIXTURE_KEY,
  );
  await settledSourceFrame(page, 18);
  const viewportRequests = (): number => server.requests.filter((r) => r.url.includes('/tile/v1/viewport')).length;
  await expect.poll(async () => (await shownCredits(page)).reported).toContain('Map data ©2026 Eastern Provider');
  expect((await shownCredits(page)).element).toContain('Map data ©2026 Eastern Provider');
  expect(viewportRequests()).toBe(1);
  // Frames of the same view ask nothing more.
  await page.evaluate(() => window.vibeglobeSources?.globe?.requestRender());
  await settledSourceFrame(page, 18);
  expect(viewportRequests()).toBe(1);
  // A view west of 0° shows the other provider.
  await page.evaluate(() =>
    window.vibeglobeSources?.globe?.jumpTo({ longitudeDeg: -74, latitudeDeg: 40.7, zoom: 6.5 }),
  );
  await settledSourceFrame(page, 18);
  await expect.poll(async () => (await shownCredits(page)).element).toContain('Map data ©2026 Western Provider');
  const { reported } = await shownCredits(page);
  expect(reported).toContain('Map data ©2026 Western Provider');
  expect(reported).not.toContain('Map data ©2026 Eastern Provider');
  expect(viewportRequests()).toBe(2);
});
