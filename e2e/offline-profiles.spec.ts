// Provider profiles in the browser (M8, track B): a profile switches off only what its provider forbids and only for
// its own source, nothing switches it back on (F320); the OpenStreetMap public servers are neither packaged nor prefetched (F324); self-hosted OpenStreetMap
// enables everything with the ODbL credit, under a commercial provider's rules when one serves it (F325); any adapter's
// own profile is enforced the same way (F326).
import { expect, test, type Page } from '@playwright/test';
import {
  emptyPixels,
  openHarness,
  recordTileRequests,
  startHarness,
  storedTileKeys,
  tileHeaders,
  type HarnessConfig,
} from './support/offline.ts';

test.beforeEach(() => test.setTimeout(180_000));
// Routes still fetching when a test ends must not fail the run outside any test (KB-213).
test.afterEach(({ page }) => page.unrouteAll({ behavior: 'ignoreErrors' }));

const ROME = { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 6 };
const PAN = [12.5, 14, 15.5];

type Bounds = [number, number, number, number];

/** A requested tile's level, column and row, from a path ending in `/{z}/{x}/{y}` (with or without `.png`). */
function tileOf(path: string): [number, number, number] {
  const [z = 0, x = 0, y = 0] = /\/(\d+)\/(\d+)\/(\d+)(?:\.png)?(?:\?|$)/.exec(path)?.slice(1).map(Number) ?? [];
  return [z, x, y];
}

function boundsOf([z, x, y]: [number, number, number]): Bounds {
  const n = 2 ** z;
  const lat = (row: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return [(x / n) * 360 - 180, lat(y + 1), ((x + 1) / n) * 360 - 180, lat(y)];
}

const overlaps = (a: Bounds, b: Bounds): boolean =>
  a[0] < b[2] - 1e-9 && b[0] < a[2] - 1e-9 && a[1] < b[3] - 1e-9 && b[1] < a[3] - 1e-9;

/** Records, in the page, the bounds of every surface tile any frame draws from now on. */
async function recordDrawn(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen = new Map<string, [number, number, number, number]>();
    const page = window as unknown as { drawn: typeof seen; slowestLinkBps: number };
    page.drawn = seen;
    page.slowestLinkBps = Number.POSITIVE_INFINITY;
    const globe = window.offlineHarness?.globe;
    globe?.on('frame', () => {
      const link = globe.imageryStats()?.bandwidthBitsPerSecond ?? Number.NaN;
      if (link < page.slowestLinkBps) page.slowestLinkBps = link;
      for (const t of globe.surfaceTiles())
        seen.set(`${t.level}/${t.x}/${t.y}`, [t.westDeg, t.southDeg, t.eastDeg, t.northDeg]);
    });
  });
}

const drawn = (page: Page): Promise<Bounds[]> =>
  page.evaluate(() => [...(window as unknown as { drawn: Map<string, Bounds> }).drawn.values()]);

/** Requested tiles of finer levels than the pinned base that no frame drew: prefetched ones. */
function beyondView(paths: readonly string[], seen: readonly Bounds[]): string[] {
  return paths.filter((p) => {
    const tile = tileOf(p);
    return tile[0] >= 5 && !seen.some((b) => overlaps(boundsOf(tile), b));
  });
}

async function panRome(page: Page): Promise<void> {
  for (const lon of PAN) {
    await page.evaluate((v) => window.offlineHarness?.globe?.jumpTo(v), { ...ROME, longitudeDeg: lon });
    expect(await emptyPixels(page)).toBe(0);
  }
}

const effective = (page: Page, sourceId: string) =>
  page.evaluate((id) => window.offlineHarness?.offline?.effectiveSwitches(id), sourceId);

const warnings = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    (window.offlineHarness?.events ?? [])
      .filter((e) => e.type === 'warning')
      .map((e) => (e.payload as { message: string }).message),
  );

const creditTexts = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.vg-credits .vg-credit')].map((item) => ({
      text: item.textContent?.trim() ?? '',
      href: item.querySelector('a')?.href ?? item.closest('a')?.href ?? '',
    })),
  );

const ALL_ON = { persistentCache: true, memoryReuse: true, prefetch: true, offlinePackaging: true };
const CACHEABLE = { 'Cache-Control': 'max-age=86400' };

async function start(page: Page, config: HarnessConfig): Promise<string[]> {
  await openHarness(page);
  await tileHeaders(page, () => CACHEABLE);
  const requests = recordTileRequests(page);
  await startHarness(page, { view: ROME, ...config });
  await recordDrawn(page);
  return requests;
}

test('a profile switches off only what its provider forbids, for its own source, and nothing switches it back on (F320)', async ({
  page,
}) => {
  const requests = await start(page, {
    sources: [
      {
        id: 'strict',
        pattern: 'world',
        session: 'f320-strict',
        profile: { id: 'strict-provider', forbids: ['persistentCache', 'prefetch'], respectCacheHeaders: true },
      },
      { id: 'open', pattern: 'levels', session: 'f320-open' },
    ],
  });
  expect(await effective(page, 'open')).toEqual(ALL_ON);
  expect(await effective(page, 'strict')).toEqual({ ...ALL_ON, persistentCache: false, prefetch: false });
  await panRome(page);
  const seen = await drawn(page);
  const session = (name: string) => requests.filter((p) => p.includes(`/${name}/`));
  expect(beyondView(session('f320-strict'), seen), 'tiles the strict source prefetched').toEqual([]);
  expect(beyondView(session('f320-open'), seen).length, 'tiles the open source prefetched').toBeGreaterThan(0);
  await expect
    .poll(async () => (await storedTileKeys(page)).filter((k) => k.startsWith('open/')).length)
    .toBeGreaterThan(0);
  expect((await storedTileKeys(page)).filter((k) => k.startsWith('strict/'))).toEqual([]);

  // The developer switches off more: memory reuse for the strict source, prefetch everywhere.
  await page.evaluate(() => {
    window.offlineHarness?.offline?.setSwitches({ memoryReuse: false }, { sourceId: 'strict' });
    window.offlineHarness?.offline?.setSwitches({ prefetch: false });
  });
  expect(await effective(page, 'strict')).toEqual({
    ...ALL_ON,
    persistentCache: false,
    prefetch: false,
    memoryReuse: false,
  });
  expect(await effective(page, 'open')).toEqual({ ...ALL_ON, prefetch: false });
  const before = requests.length;
  await recordDrawn(page);
  for (const lon of [20, 21.5]) {
    await page.evaluate((v) => window.offlineHarness?.globe?.jumpTo(v), { ...ROME, longitudeDeg: lon });
    expect(await emptyPixels(page)).toBe(0);
  }
  expect(beyondView(requests.slice(before), await drawn(page)), 'prefetched after prefetch was switched off').toEqual(
    [],
  );

  // Switching a forbidden feature on, globally and for the source, leaves it off and warns naming the profile.
  await page.evaluate(() => {
    window.offlineHarness?.offline?.setSwitches({ persistentCache: true });
    window.offlineHarness?.offline?.setSwitches({ persistentCache: true, prefetch: true }, { sourceId: 'strict' });
  });
  expect((await effective(page, 'strict'))?.persistentCache).toBe(false);
  expect((await effective(page, 'strict'))?.prefetch).toBe(false);
  await page.evaluate((v) => window.offlineHarness?.globe?.jumpTo(v), { ...ROME, longitudeDeg: 9 });
  expect(await emptyPixels(page)).toBe(0);
  expect((await storedTileKeys(page)).filter((k) => k.startsWith('strict/'))).toEqual([]);
  expect(await warnings(page)).toEqual([
    "persistentCache stays off for source 'strict': its provider profile 'strict-provider' forbids it",
    "prefetch stays off for source 'strict': its provider profile 'strict-provider' forbids it",
  ]);
});

test('the OpenStreetMap public servers are neither prefetched in bulk nor packaged (F324)', async ({ page }) => {
  const requests = await start(page, {
    switches: ALL_ON,
    sources: [
      { id: 'osm', provider: 'osm-public', session: 'f324-osm', pattern: 'world' },
      { id: 'world', pattern: 'levels', session: 'f324-world' },
    ],
  });
  await panRome(page);
  await page.evaluate(async () => {
    await window.offlineHarness?.globe?.flyTo(
      { longitudeDeg: 2.35, latitudeDeg: 48.85, zoom: 7 },
      { durationMs: 3000 },
    );
  });
  expect(await emptyPixels(page)).toBe(0);
  const seen = await drawn(page);
  const osm = requests.filter((p) => p.includes('/f324-osm/'));
  expect(osm.length).toBeGreaterThan(0);
  expect(beyondView(osm, seen), 'OpenStreetMap tiles prefetched').toEqual([]);
  expect(
    beyondView(
      requests.filter((p) => p.includes('/f324-world/')),
      seen,
    ).length,
  ).toBeGreaterThan(0);
  const build = await page.evaluate(() =>
    window.offlineHarness?.buildArea({
      id: 'with-osm',
      version: '1',
      area: { westDeg: 12, southDeg: 41.5, eastDeg: 13, northDeg: 42.2 },
      minLevel: 0,
      maxLevel: 6,
      sources: [{ id: 'osm', provider: 'osm-public', session: 'f324-osm', pattern: 'world' }],
    }),
  );
  expect(build?.error).toMatch(/provider profile 'osm-public' forbids offline packaging/);
});

test('self-hosted OpenStreetMap enables everything with the ODbL credit; a provider adds its own rules and credit (F325)', async ({
  page,
}) => {
  await start(page, {
    sources: [{ id: 'osm', provider: 'osm-hosted', session: 'f325-hosted', pattern: 'world' }],
  });
  expect(await effective(page, 'osm')).toEqual(ALL_ON);
  await panRome(page);
  await expect.poll(async () => (await storedTileKeys(page)).length).toBeGreaterThan(0);
  const credits = await creditTexts(page);
  expect(credits).toContainEqual({
    text: '© OpenStreetMap contributors, ODbL',
    href: 'https://www.openstreetmap.org/copyright',
  });

  // The same data through a commercial provider whose profile forbids persistent caching and asks for its credit.
  await startHarness(page, {
    view: ROME,
    sources: [
      {
        id: 'osm-provider',
        provider: 'osm-hosted',
        session: 'f325-provider',
        pattern: 'world',
        profile: {
          id: 'maps-inc',
          forbids: ['persistentCache'],
          respectCacheHeaders: true,
          requiredAttribution: { text: '© Maps Inc.', url: 'https://maps.example/terms' },
        },
      },
    ],
  });
  expect(await effective(page, 'osm-provider')).toEqual({ ...ALL_ON, persistentCache: false });
  await panRome(page);
  expect((await storedTileKeys(page)).filter((k) => k.startsWith('osm-provider/'))).toEqual([]);
  const texts = (await creditTexts(page)).map((c) => c.text);
  expect(texts).toContain('© OpenStreetMap contributors, ODbL');
  expect(texts).toContain('© Maps Inc.');
});

test('an adapter declaring its own profile is enforced like the built-in ones (F326)', async ({ page }) => {
  let inFlight = 0;
  let most = 0;
  await openHarness(page);
  await page.route('**/fixture-tiles/f326-acme/**', async (route) => {
    inFlight++;
    most = Math.max(most, inFlight);
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 60));
    inFlight--;
    const headers = { ...response.headers(), ...CACHEABLE };
    return route.fulfill({ response, headers });
  });
  await startHarness(page, {
    view: ROME,
    switches: ALL_ON,
    sources: [
      {
        id: 'acme',
        pattern: 'world',
        session: 'f326-acme',
        profile: {
          id: 'acme',
          forbids: ['persistentCache', 'offlinePackaging'],
          respectCacheHeaders: true,
          maxConcurrentRequests: 2,
          requiredAttribution: { text: 'Acme Maps', url: 'https://acme.example/' },
        },
      },
    ],
  });
  await panRome(page);
  expect(await storedTileKeys(page)).toEqual([]);
  expect(most).toBeGreaterThan(0);
  expect(most).toBeLessThanOrEqual(2);
  expect((await creditTexts(page)).map((c) => c.text)).toContain('Acme Maps');
  const build = await page.evaluate(() =>
    window.offlineHarness?.buildArea({
      id: 'with-acme',
      version: '1',
      area: { westDeg: 12, southDeg: 41.5, eastDeg: 13, northDeg: 42.2 },
      minLevel: 0,
      maxLevel: 6,
      sources: [
        {
          id: 'acme',
          pattern: 'world',
          session: 'f326-acme',
          profile: { id: 'acme', forbids: ['persistentCache', 'offlinePackaging'], respectCacheHeaders: true },
        },
      ],
    }),
  );
  expect(build?.error).toMatch(/provider profile 'acme' forbids offline packaging/);
});
