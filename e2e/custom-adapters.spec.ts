// F219: a consumer's own imagery and terrain adapters, from a package outside packages/
// (scripts/fixtures/custom-adapters/), attached in the playground through the public API (`?custom=quadkey`), render
// with no black pixel on both backends. Their quadkey service is answered from the fixture tile server.
import { expect, test, type Page } from '@playwright/test';
import { canvasImage, expectCompleteGlobe, openGlobe, waitForIdle } from './support/globe.ts';
import { waitForStreaming } from './support/imagery.ts';

test.use({ viewport: { width: 320, height: 240 } });

/** The Web Mercator tile of a quadkey. */
function tileOf(key: string): { z: number; x: number; y: number } {
  let x = 0;
  let y = 0;
  for (const digit of key) {
    const d = Number(digit);
    x = x * 2 + (d & 1);
    y = y * 2 + (d >> 1);
  }
  return { z: key.length, x, y };
}

/** Answers the adapters' quadkey service from the fixture tile server, and counts the requests by extension. */
async function serveQuadkeys(page: Page, session: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  await page.route('https://quadkeys.test/**', async (route) => {
    const [, key = '', extension = ''] = /\/(\d+)\.(png|f32)$/.exec(route.request().url()) ?? [];
    counts.set(extension, (counts.get(extension) ?? 0) + 1);
    const { z, x, y } = tileOf(key);
    const path = extension === 'png' ? 'world/mercator' : 'terrain/mercator';
    const response = await route.fetch({
      url: new URL(`/fixture-tiles/${session}/${path}/${z}/${x}/${y}.${extension}`, page.url()).href,
    });
    await route.fulfill({ response, headers: { ...response.headers(), 'access-control-allow-origin': '*' } });
  });
  return counts;
}

/** Pixels darker than the darkest imagery: holes in the surface. */
function blackPixels(image: Awaited<ReturnType<typeof canvasImage>>): number {
  let black = 0;
  for (let i = 0; i < image.data.length; i += 4)
    if ((image.data[i] ?? 0) + (image.data[i + 1] ?? 0) + (image.data[i + 2] ?? 0) < 15) black++;
  return black;
}

for (const backend of ['webgpu', 'webgl2'] as const)
  test(`custom imagery and terrain adapters from a package outside packages/ render with no black pixels on ${backend} (F219)`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await page.goto('/');
    const counts = await serveQuadkeys(page, 'custom-adapters');
    // The whole globe, then a tilted view over the fixture terrain's peak.
    await openGlobe(page, `backend=${backend}&custom=quadkey&zoom=2.5`);
    await waitForStreaming(page);
    await expectCompleteGlobe(page);
    await openGlobe(page, `backend=${backend}&custom=quadkey&lon=6.9&lat=45.6&zoom=9&tilt=40`);
    await waitForStreaming(page);
    await waitForIdle(page);
    const image = await canvasImage(page);
    await testInfo.attach(`custom-adapters-${backend}.png`, {
      body: await page.locator('canvas').first().screenshot(),
      contentType: 'image/png',
    });
    expect(blackPixels(image)).toBe(0);
    // Both adapters streamed, and the terrain displaces the surface.
    expect(counts.get('png') ?? 0).toBeGreaterThan(0);
    expect(counts.get('f32') ?? 0).toBeGreaterThan(0);
    const height = await page.evaluate(
      () =>
        window.vibeglobePlayground?.globe.elevationAt({ longitudeDeg: 6.86, latitudeDeg: 45.83 })?.heightMeters ?? 0,
    );
    expect(height).toBeGreaterThan(2000);
  });
