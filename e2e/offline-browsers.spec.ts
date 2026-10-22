// The browser-storage behavior of @vibeglobe/offline in every engine (F273, F276): these checks drive the offline
// engine's sources and API directly, without a globe, so they run where the runner has no WebGL (CI's Firefox and
// WebKit job). The rendering side of F273 is in e2e/offline-cache.spec.ts.
import { expect, test, type Page } from '@playwright/test';
import { openHarness, recordTileRequests, tileHeaders } from './support/offline.ts';

const TILES = [
  [3, 4, 2],
  [3, 4, 3],
  [4, 8, 5],
  [4, 9, 5],
  [5, 17, 11],
  [6, 34, 23],
] as const;

/** Loads tiles through a wrapped source in the page; resolves the tier each came from. */
async function loadTiles(page: Page): Promise<string[]> {
  return page.evaluate(async (tiles) => {
    const repo = location.pathname.replace(/\/e2e\/support\/[^/]*$/, '');
    type Source = {
      request(c: unknown, o: { url: string; hostIndex: number }): { url: string; hostIndex: number } | 'noData';
      transport: { start(r: unknown, t: unknown, done: (r: { kind: string }) => void): void };
    };
    const offlineModule = (await import(/* @vite-ignore */ `${repo}/packages/offline/src/index.ts`)) as {
      createOffline(o: unknown): {
        source(s: unknown): Source;
        destroy(): void;
        on(e: string, h: (p: { tier: string }) => void): void;
      };
    };
    const sources = (await import(/* @vite-ignore */ `${repo}/packages/sources/src/index.ts`)) as {
      xyzImagery(o: unknown): unknown;
    };
    const tiers: string[] = [];
    const offline = offlineModule.createOffline({ onServe: (event: { tier: string }) => tiers.push(event.tier) });
    const source = offline.source(
      sources.xyzImagery({
        id: 'world',
        url: `${location.origin}/fixture-tiles/browsers/world/mercator/{z}/{x}/{y}.png`,
      }),
    );
    for (const [level, x, y] of tiles) {
      const request = source.request({ root: 0, level, x, y }, { url: '', hostIndex: 0 });
      if (request === 'noData') throw new Error('no data');
      const result = await new Promise<{ kind: string }>((done) =>
        source.transport.start(request, { firstByteMs: 10_000, totalMs: 10_000 }, done),
      );
      if (result.kind !== 'ok') throw new Error(`tile ${level}/${x}/${y}: ${result.kind}`);
    }
    // Let the cache worker finish its writes before the page goes away.
    await new Promise((resolve) => setTimeout(resolve, 500));
    offline.destroy();
    return tiers;
  }, TILES);
}

test('tiles cached in browser storage are served after a reload without a request (F273)', async ({ page }) => {
  await openHarness(page);
  await tileHeaders(page, () => ({ 'Cache-Control': 'max-age=86400' }));
  const first = recordTileRequests(page);
  expect(await loadTiles(page)).toEqual(TILES.map(() => 'network'));
  expect(first).toHaveLength(TILES.length);
  await page.reload();
  await openHarness(page, { keepStorage: true });
  await tileHeaders(page, () => ({ 'Cache-Control': 'max-age=86400' }));
  const second = recordTileRequests(page);
  expect(await loadTiles(page)).toEqual(TILES.map(() => 'persistent'));
  expect(second).toEqual([]);
});

test('requesting persistent storage reports the browser answer and the persisted state (F276)', async ({ page }) => {
  await openHarness(page);
  const { result, persisted } = await page.evaluate(async () => {
    const repo = location.pathname.replace(/\/e2e\/support\/[^/]*$/, '');
    const offline = (await import(/* @vite-ignore */ `${repo}/packages/offline/src/index.ts`)) as {
      requestPersistence(): Promise<{ status: string; persisted: boolean }>;
    };
    const answer = await offline.requestPersistence();
    return { result: answer, persisted: navigator.storage?.persisted ? await navigator.storage.persisted() : false };
  });
  expect(['granted', 'denied']).toContain(result.status);
  expect(result.persisted).toBe(persisted);
});
