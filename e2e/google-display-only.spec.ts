// Google content is for display only (F323, ADR 0031): reading it back is refused, naming the Google profile.
import { expect, test, type Route } from '@playwright/test';
import { GOOGLE_FIXTURE_KEY, googleFixture } from '../packages/sources/src/__fixtures__/google-server.ts';
import { mountSource, openSources, tilePng, waitForSourceIdle, waitForSourceImagery } from './support/sources.ts';

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

test('pixel readback of a globe drawing Google tiles is refused, naming the Google profile (F323)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const server = googleFixture(tilePng);
  await page.route('https://tile.googleapis.com/**', (route) => fulfillFrom(route, server.fetch));
  await openSources(page, 'lon=12.5&lat=41.9&zoom=6.5');
  await mountSource(
    page,
    "(s, key) => s.googleImagery({ id: 'google', apiKey: key, billingRegion: 'eea', mapType: 'roadmap' })",
    GOOGLE_FIXTURE_KEY,
  );
  // Settled without reading the frame back (which is refused).
  await waitForSourceImagery(page, 18);
  await waitForSourceIdle(page);
  const capture = (): Promise<{ code?: string | undefined; message: string }> =>
    page.evaluate(async () => {
      try {
        await window.vibeglobeSources?.globe?.captureFrame();
        return { message: 'captured' };
      } catch (error) {
        return { code: (error as { code?: string }).code, message: String((error as Error).message) };
      }
    });
  const refused = await capture();
  expect(refused.code).toBe('display-only');
  expect(refused.message).toContain("source 'google' is display only under the 'google' profile");
  // Hidden, the layer is not drawn: the frame may be read.
  await page.evaluate(() => {
    const layers = window.vibeglobeSources?.globe?.imageryLayers;
    for (const layer of layers?.list() ?? []) layers?.set(layer.id, { visible: false });
  });
  expect(await capture()).toEqual({ message: 'captured' });
});
