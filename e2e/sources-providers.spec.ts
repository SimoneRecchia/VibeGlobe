// Provider profiles on the globe: the OpenStreetMap public servers see at most two requests at once during fast
// navigation, a Referer identifying the application on every request, and the page logs exactly one warning
// (F265–F267); their credit is linked and their cache headers honored (F264); a provider's required logo and credit,
// declared by the application's own profile, stay visible and uncovered (F255, F679).
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import {
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

async function jump(page: Page, view: { longitudeDeg: number; latitudeDeg: number; zoom: number }): Promise<void> {
  await page.evaluate((v) => window.vibeglobeSources?.globe?.jumpTo(v), view);
}

test.describe('provider profiles on the globe', () => {
  // Several settled views on the container's software GPU.
  test.setTimeout(240_000);

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

/** A 1 × 1 PNG standing in for the application's copy of a provider's logo. */
const LOGO =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==';

/** Each credit item and its logo: fully inside the viewport, visible, and the topmost element at its corners. */
async function credits(page: Page) {
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

test.describe("a provider's required logo and credit (F255, F679)", () => {
  test.setTimeout(240_000);
  const sizes = [
    { name: 'desktop', width: 1280, height: 800 },
    { name: 'tablet', width: 1024, height: 768 },
    { name: 'phone', width: 390, height: 844 },
  ];
  // The application's own provider: its tiles from a stand-in host, its logo and credit required by its profile.
  const mountProvider = async (page: Page, hiddenCredits?: readonly string[]) => {
    await page.route('https://tiles.provider.test/**', (route) => {
      const [z = 0, x = 0, y = 0] =
        /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(route.request().url())?.slice(1).map(Number) ?? [];
      return route.fulfill({
        status: 200,
        contentType: 'image/png',
        headers: CORS,
        body: Buffer.from(tilePng(z, x, y)),
      });
    });
    await openSources(page, 'lon=12.5&lat=41.9&zoom=4');
    await mountSource(
      page,
      `(s, logo) => {
        const credit = { text: 'Provider', logo: { src: logo, alt: 'Provider' } };
        return s.xyzImagery({
          id: 'provider',
          url: 'https://tiles.provider.test/{z}/{x}/{y}.png',
          attribution: [credit],
          profile: { id: 'provider', requiredAttribution: credit, displayOnly: true },
        });
      }`,
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
        await mountProvider(page);
        await expect.poll(() => credits(page)).toContainEqual({ text: 'Provider', shown: true, logo: 'shown' });
        for (const credit of await credits(page)) expect(credit, credit.text).toMatchObject({ shown: true });
      });
    }

  test('stay visible when configuration or the page CSS tries to hide or cover them', async ({ page }) => {
    // The regression test of TB-02 (docs/known-bugs.md): the logo inside the credits element stays pinned.
    await page.setViewportSize({ width: 800, height: 600 });
    await mountProvider(page, ['provider']);
    await expect.poll(() => credits(page)).toContainEqual({ text: 'Provider', shown: true, logo: 'shown' });
    await page.addStyleTag({
      content:
        '.vg-credits, .vg-credit img { display: none !important; visibility: hidden !important; opacity: 0 !important; }' +
        '.vg-ui * { z-index: 2147483647 !important; }',
    });
    await page.evaluate(() => window.vibeglobeSources?.globe?.requestRender());
    await expect
      .poll(() => credits(page), { message: 'after the page CSS' })
      .toContainEqual({ text: 'Provider', shown: true, logo: 'shown' });
    // The profile declares display-only use: reading the drawn pixels back is refused.
    const refusal = await page.evaluate(() =>
      window.vibeglobeSources?.globe?.captureView({ widthPx: 64, heightPx: 64 }).then(
        () => 'captured',
        (error: unknown) => (error as { code?: string }).code,
      ),
    );
    expect(refusal).toBe('display-only');
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
