// The Google and OpenStreetMap provider profiles on the globe: a Google session that expires is renewed without a blank
// pixel (F257); the OpenStreetMap public servers see at most two requests at once during fast navigation, a Referer
// identifying the application on every request, and the page logs exactly one warning (F265–F267); their credit is
// linked and their cache headers honored (F264); the Google logo and credits stay visible and uncovered (F259).
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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

/** A 1 × 1 PNG standing in for the application's copy of the Google logo. */
const LOGO =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==';

/** Each credit item and its logo: fully inside the viewport, visible, and the topmost element at its corners. */
async function googleCredits(page: Page) {
  return page.evaluate(() => {
    const unobstructed = (element: Element): boolean => {
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return false;
      if (box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight) return false;
      const inset = 1;
      return [
        [box.left + inset, box.top + inset],
        [box.right - inset, box.top + inset],
        [box.left + inset, box.bottom - inset],
        [box.right - inset, box.bottom - inset],
        [box.left + box.width / 2, box.top + box.height / 2],
      ].every(([x, y]) => {
        const top = document.elementFromPoint(x ?? 0, y ?? 0);
        return top !== null && (element === top || element.contains(top));
      });
    };
    const visible = (element: Element): boolean => {
      for (let e: Element | null = element; e; e = e.parentElement) {
        const style = getComputedStyle(e);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 1) return false;
      }
      return true;
    };
    return [...document.querySelectorAll('.vg-credits .vg-credit')].map((item) => {
      const logo = item.querySelector('img');
      return {
        text: item.textContent?.trim() ?? '',
        shown: visible(item) && unobstructed(item),
        logo: logo === null ? 'none' : visible(logo) && unobstructed(logo) ? 'shown' : 'covered',
      };
    });
  });
}

/** Adds the UI package's layer with every default control over the mounted globe. */
async function addEveryControl(page: Page): Promise<void> {
  await page.evaluate(async (entry) => {
    const ui = (await import(/* @vite-ignore */ entry)) as typeof import('@vibeglobe/ui');
    const globe = window.vibeglobeSources?.globe;
    const container = document.querySelector<HTMLElement>('.vg-source-test');
    if (!globe || !container) throw new Error('no mounted globe');
    ui.addDefaultControls(ui.createUi(globe, container), { debug: true });
  }, `/@fs${process.cwd()}/packages/ui/src/index.ts`);
}

test.describe('the Google logo and credits (F259)', () => {
  test.setTimeout(240_000);
  const sizes = [
    { name: 'desktop', width: 1280, height: 800 },
    { name: 'tablet', width: 1024, height: 768 },
    { name: 'phone', width: 390, height: 844 },
  ];
  const mountGoogle = async (page: Page, hiddenCredits?: readonly string[]) => {
    const server = googleFixture(tilePng);
    await page.route('https://tile.googleapis.com/**', (route) => fulfillFrom(route, server.fetch));
    await openSources(page, 'lon=12.5&lat=41.9&zoom=4');
    await mountSource(
      page,
      `(s, logo) => s.googleImagery({ id: 'google', apiKey: '${GOOGLE_FIXTURE_KEY}', billingRegion: 'eea', mapType: 'roadmap', logoUrl: logo })`,
      LOGO,
      hiddenCredits ? { hiddenCredits } : {},
    );
    await addEveryControl(page);
  };

  for (const size of sizes)
    for (const orientation of ['landscape', 'portrait'] as const) {
      const [width, height] =
        (orientation === 'landscape') === size.width > size.height
          ? [size.width, size.height]
          : [size.height, size.width];
      test(`stay visible and uncovered with every control, ${size.name} ${orientation} (${width} × ${height})`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height });
        await mountGoogle(page);
        await expect.poll(() => googleCredits(page)).toContainEqual({ text: 'Google', shown: true, logo: 'shown' });
        for (const credit of await googleCredits(page)) expect(credit, credit.text).toMatchObject({ shown: true });
      });
    }

  test('stay visible when configuration or the page CSS tries to hide or cover them', async ({ page }) => {
    // TB-02 (docs/known-bugs.md): the logo inside the engine's credits element is not pinned against page CSS; the
    // renderer's fix (hook request 5 of track B) turns this regression test green, and this annotation is removed.
    test.fail();
    await page.setViewportSize({ width: 800, height: 600 });
    await mountGoogle(page, ['google']);
    await expect.poll(() => googleCredits(page)).toContainEqual({ text: 'Google', shown: true, logo: 'shown' });
    await page.addStyleTag({
      content:
        '.vg-credits, .vg-credit img { display: none !important; visibility: hidden !important; opacity: 0 !important; }' +
        '.vg-ui * { z-index: 2147483647 !important; }',
    });
    await page.evaluate(() => window.vibeglobeSources?.globe?.requestRender());
    await expect
      .poll(() => googleCredits(page), { message: 'after the page CSS' })
      .toContainEqual({ text: 'Google', shown: true, logo: 'shown' });
  });
});

test('the OpenStreetMap public profile: the linked credit while its tiles show, cache headers honored, no no-cache request (F264)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  // A stand-in for tile.openstreetmap.org on its own origin, so the browser's HTTP cache applies (routing disables it).
  const requests: { path: string; cacheControl?: string; pragma?: string }[] = [];
  const server = createServer((request, response) => {
    const [z = 0, x = 0, y = 0] =
      /\/(\d+)\/(\d+)\/(\d+)\.png$/
        .exec(request.url ?? '')
        ?.slice(1)
        .map(Number) ?? [];
    requests.push({
      path: request.url ?? '',
      ...(request.headers['cache-control'] ? { cacheControl: request.headers['cache-control'] } : {}),
      ...(typeof request.headers.pragma === 'string' ? { pragma: request.headers.pragma } : {}),
    });
    response.writeHead(200, {
      'Content-Type': 'image/png',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'max-age=604800',
    });
    response.end(Buffer.from(tilePng(z, x, y)));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  try {
    await openSources(page, 'lon=12.5&lat=41.9&zoom=4');
    const origin = new URL(page.url()).origin;
    await mountSource(
      page,
      `(s, v) => s.openStreetMapImagery({ appName: 'VibeGlobe tests', appUrl: v.origin, url: v.url, warn: () => {} })`,
      { origin, url: `http://127.0.0.1:${port}/{z}/{x}/{y}.png` },
    );
    await expectNoEmptyPixels(page, await settledSourceFrame(page, 19));
    const credits = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.vg-credits .vg-credit')].map((item) => ({
        text: item.textContent?.trim() ?? '',
        href: item.querySelector('a')?.href ?? item.closest('a')?.href ?? '',
      })),
    );
    expect(credits).toContainEqual({
      text: '© OpenStreetMap contributors',
      href: 'https://www.openstreetmap.org/copyright',
    });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.filter((r) => r.cacheControl !== undefined || r.pragma !== undefined)).toEqual([]);
    // The engine drops every tile it holds and asks again: the browser answers from its HTTP cache, as the headers
    // allow, and the server sees no request.
    const before = requests.length;
    await page.evaluate(() => window.vibeglobeSources?.globe?.reloadSource('osm-public'));
    await expectNoEmptyPixels(page, await settledSourceFrame(page, 19));
    expect(requests.length).toBe(before);
  } finally {
    server.close();
  }
});
