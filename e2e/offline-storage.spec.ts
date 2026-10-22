// Browser storage of @vibeglobe/offline (M8, offline track): eviction by the browser and persistence requests.
import { expect, test, type Page } from '@playwright/test';
import {
  emptyPixels,
  openHarness,
  startHarness,
  storedTiles,
  tileHeaders,
  viewAt,
  type HarnessConfig,
} from './support/offline.ts';

const CONFIG: HarnessConfig = {
  sources: [{ id: 'world', pattern: 'world', session: 'f275' }],
  view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 6 },
};
const ROME_PACKAGE = {
  id: 'rome',
  version: '1',
  sourceId: 'world',
  pattern: 'patches',
  session: 'f275-package',
  bounds: { westDeg: 11.5, southDeg: 41.2, eastDeg: 13.5, northDeg: 42.6 },
  minLevel: 0,
  maxLevel: 7,
};

async function lostEvents(page: Page): Promise<{ cache: boolean; packages: string[] }[]> {
  return page.evaluate(
    () =>
      window.offlineHarness?.events
        .filter((e) => e.type === 'storage-lost')
        .map((e) => e.payload as { cache: boolean; packages: string[] }) ?? [],
  );
}

/** Installs the Rome package and fills the cache with a view elsewhere. */
async function fill(page: Page): Promise<void> {
  await page.evaluate((spec) => window.offlineHarness?.installFixture(spec), ROME_PACKAGE);
  expect(await viewAt(page, 40, 41.9, 6)).toBe(0);
  await expect.poll(async () => (await storedTiles(page)).length).toBeGreaterThan(5);
}

test('storage the browser deletes, while open or between sessions, is reported and the view falls back (F275)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openHarness(page);
  await tileHeaders(page, () => ({ 'Cache-Control': 'max-age=86400' }));
  await startHarness(page, CONFIG);
  await fill(page);
  // The browser deletes everything while the page is open (as "clear site data" does).
  await page.evaluate(() => indexedDB.deleteDatabase('vibeglobe-offline'));
  await expect
    .poll(() => lostEvents(page))
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cache: true }),
        expect.objectContaining({ cache: false, packages: ['rome'] }),
      ]),
    );
  expect(await page.evaluate(() => window.offlineHarness?.manager?.list())).toEqual([]);
  await page.evaluate(() => window.offlineHarness?.restartGlobe());
  expect(await viewAt(page, 12.5, 41.9, 7)).toBe(0);
  expect(await viewAt(page, 40, 41.9, 6)).toBe(0);
  const tiers = await page.evaluate(() => window.offlineHarness?.served.map((e) => e.tier) ?? []);
  expect(tiers).not.toContain('package');
  expect(tiers).toContain('network');

  // Between sessions: the next page finds the database gone.
  await fill(page);
  await page.reload();
  await openHarness(page, { keepStorage: true });
  await tileHeaders(page, () => ({ 'Cache-Control': 'max-age=86400' }));
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        const request = indexedDB.deleteDatabase('vibeglobe-offline');
        request.onsuccess = request.onerror = request.onblocked = () => done();
      }),
  );
  await startHarness(page, CONFIG);
  await expect
    .poll(() => lostEvents(page))
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cache: true }),
        expect.objectContaining({ packages: ['rome'] }),
      ]),
    );
  expect(await emptyPixels(page)).toBe(0);
});

test('apps can request persistent storage and read the answer; without the Storage API it is unsupported (F276)', async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    const storage = navigator.storage;
    const calls = { persist: 0 };
    (window as unknown as { persistCalls: typeof calls }).persistCalls = calls;
    const persist = storage.persist.bind(storage);
    storage.persist = () => {
      calls.persist++;
      return persist();
    };
  });
  await openHarness(page);
  await startHarness(page, CONFIG);
  const result = await page.evaluate(() => window.offlineHarness?.offline?.requestPersistentStorage());
  const browser = await page.evaluate(async () => ({
    calls: (window as unknown as { persistCalls: { persist: number } }).persistCalls.persist,
    persisted: await navigator.storage.persisted(),
  }));
  expect(browser.calls).toBe(1);
  expect(result?.persisted).toBe(browser.persisted);
  expect(result?.status).toBe(browser.persisted ? 'granted' : 'denied');

  const bare = await context.newPage();
  await bare.addInitScript(() => Object.defineProperty(Navigator.prototype, 'storage', { get: () => undefined }));
  await openHarness(bare, { keepStorage: true });
  const unsupported = await bare.evaluate(async () => {
    const offline = (await import(
      /* @vite-ignore */ `${location.pathname.replace(/\/e2e\/support\/[^/]*$/, '')}/packages/offline/src/index.ts`
    )) as {
      requestPersistence(): Promise<unknown>;
    };
    return offline.requestPersistence();
  });
  expect(unsupported).toEqual({ status: 'unsupported', persisted: false });
});
