// Offline packages of @vibeglobe/offline in the browser (M8, offline track): installing from a URL and from local
// files, listing, storage use, versions, removal, resumed installs, integrity checks, partial packages and
// in-browser builds honouring the packaging switch and provider rules.
import { expect, test, type Page } from '@playwright/test';
import {
  emptyPixels,
  openHarness,
  publishFixture,
  recordTileRequests,
  servePackages,
  startHarness,
  storedTiles,
  tileHeaders,
  viewAt,
  type HarnessConfig,
} from './support/offline.ts';

const ROME_BOUNDS = { westDeg: 11.5, southDeg: 41.2, eastDeg: 13.5, northDeg: 42.6 };
const ROME = {
  id: 'rome',
  version: '1',
  sourceId: 'world',
  pattern: 'patches',
  session: 'pkg-rome',
  bounds: ROME_BOUNDS,
  minLevel: 0,
  maxLevel: 7,
  license: 'ODbL-1.0',
  attribution: '© Rome fixture',
};
const OFFLINE: HarnessConfig = {
  network: 'offline',
  sources: [{ id: 'world', pattern: 'world', session: 'pkg-online' }],
  view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 7 },
};

/** Keys of the package files stored in IndexedDB. */
async function packageFileKeys(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((done) => {
        const open = indexedDB.open('vibeglobe-offline');
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('package-files')) return done([]);
          const request = db.transaction('package-files').objectStore('package-files').getAllKeys();
          request.onsuccess = () => {
            db.close();
            done(request.result as string[]);
          };
        };
      }),
  );
}

async function servedPackages(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window.offlineHarness?.served ?? []).filter((e) => e.tier === 'package').map((e) => e.packageId ?? ''),
  );
}

async function install(page: Page, url: string, abortAtHalf = false): Promise<{ progress: number[]; error?: string }> {
  return page.evaluate(
    async ({ url, abortAtHalf }) => {
      const progress: number[] = [];
      (window as unknown as { progress: number[] }).progress = progress;
      try {
        await window.offlineHarness?.manager?.install(url, {
          onProgress: (p) => {
            progress.push(p.loadedBytes / p.totalBytes);
            (window as unknown as { resumed: number }).resumed = p.resumedBytes;
          },
        });
        return { progress };
      } catch (error) {
        return { progress, error: String(error) };
      }
      void abortAtHalf;
    },
    { url, abortAtHalf },
  );
}

test('packages install from a URL and from a local file, list with their metadata and storage use, survive a reload (F311, F313)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openHarness(page);
  await tileHeaders(page, () => ({ 'Cache-Control': 'max-age=86400' }));
  const server = await servePackages(page);
  await startHarness(page, { ...OFFLINE, network: 'hybrid' });
  const { manifestUrl, file } = await publishFixture(page, server, ROME);
  const { progress, error } = await install(page, manifestUrl);
  expect(error).toBeUndefined();
  expect(progress.length).toBeGreaterThan(0);
  expect(progress.at(-1)).toBe(1);
  await page.evaluate(() =>
    window.offlineHarness?.installFixture({
      id: 'naples',
      version: '3',
      sourceId: 'world',
      pattern: 'levels',
      session: 'pkg-naples',
      bounds: { westDeg: 14, southDeg: 40.6, eastDeg: 14.5, northDeg: 41 },
      minLevel: 0,
      maxLevel: 6,
      format: 'mbtiles',
      license: 'CC-BY-4.0',
    }),
  );
  const list = await page.evaluate(() => window.offlineHarness?.manager?.list());
  const byId = new Map(list?.map((p) => [p.id, p]));
  expect(byId.get('rome')).toMatchObject({
    name: 'rome',
    version: '1',
    area: ROME_BOUNDS,
    minLevel: 0,
    maxLevel: 7,
    licenses: ['ODbL-1.0'],
    bytes: file.length,
  });
  expect(byId.get('rome')?.sources[0]).toMatchObject({ sourceId: 'world', attribution: { text: '© Rome fixture' } });
  expect(byId.get('naples')).toMatchObject({ version: '3', minLevel: 0, maxLevel: 6, licenses: ['CC-BY-4.0'] });

  // Storage use: per package and in total, matching what is stored, and the browser's quota.
  expect(await viewAt(page, 40, 41.9, 6)).toBe(0);
  await expect.poll(async () => (await storedTiles(page)).length).toBeGreaterThan(3);
  const usage = await page.evaluate(() => window.offlineHarness?.manager?.storageUsage());
  const cached = (await storedTiles(page)).reduce((sum, t) => sum + t.bytes, 0);
  expect(Math.abs((usage?.packages.find((p) => p.id === 'rome')?.bytes ?? 0) - file.length)).toBeLessThanOrEqual(
    file.length * 0.05,
  );
  expect(Math.abs((usage?.cacheBytes ?? 0) - cached)).toBeLessThanOrEqual(cached * 0.05);
  expect(usage?.totalBytes).toBe((usage?.cacheBytes ?? 0) + (usage?.packages.reduce((s, p) => s + p.bytes, 0) ?? 0));
  expect(usage?.quotaBytes).toBeGreaterThan(0);

  await page.reload();
  await openHarness(page, { keepStorage: true });
  const fixtureRequests = recordTileRequests(page);
  await startHarness(page, OFFLINE);
  const again = await page.evaluate(() => window.offlineHarness?.manager?.list());
  expect(again?.map((p) => `${p.id}@${p.version}`).sort()).toEqual(['naples@3', 'rome@1']);
  // Offline only: the package and the cache carry the view, without a single network request.
  expect(await emptyPixels(page)).toBe(0);
  const tiers = await page.evaluate(() => window.offlineHarness?.served.map((e) => e.tier) ?? []);
  expect(tiers.filter((t) => t === 'package').length).toBeGreaterThan(0);
  expect(tiers.length).toBeGreaterThan(5);
  expect(tiers).not.toContain('network');
  expect(fixtureRequests).toEqual([]);
});

test('a new version replaces the old one everywhere; removing a package frees its storage and the view falls back (F279, F312)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openHarness(page);
  await tileHeaders(page, () => ({ 'Cache-Control': 'max-age=86400' }));
  const server = await servePackages(page);
  await startHarness(page, OFFLINE);
  const { manifestUrl } = await publishFixture(page, server, ROME);
  expect((await install(page, manifestUrl)).error).toBeUndefined();
  await page.evaluate(() => window.offlineHarness?.restartGlobe());
  expect(await emptyPixels(page)).toBe(0);
  expect(new Set(await servedPackages(page))).toEqual(new Set(['rome@1']));

  await publishFixture(page, server, { ...ROME, version: '2', pattern: 'levels', session: 'pkg-rome-2' });
  // The running globe shows the new version at once: the update drops the old version's tiles from its GPU and RAM
  // tiers (`Globe.reloadSource`, KB-PT-19), without a restart.
  await page.evaluate(() => {
    if (window.offlineHarness) window.offlineHarness.served.length = 0;
  });
  await page.evaluate(() => window.offlineHarness?.manager?.update('rome'));
  expect((await page.evaluate(() => window.offlineHarness?.manager?.list()))?.map((p) => p.version)).toEqual(['2']);
  expect(await emptyPixels(page)).toBe(0);
  const served = await servedPackages(page);
  expect(served.length).toBeGreaterThan(5);
  expect(new Set(served)).toEqual(new Set(['rome@2']));
  const keys = await packageFileKeys(page);
  expect(keys.some((k) => k.startsWith('rome@2/'))).toBe(true);
  expect(keys.filter((k) => k.startsWith('rome@1/'))).toEqual([]);

  await page.evaluate(() => window.offlineHarness?.manager?.remove('rome'));
  expect(await page.evaluate(() => window.offlineHarness?.manager?.list())).toEqual([]);
  expect(await packageFileKeys(page)).toEqual([]);
  expect((await page.evaluate(() => window.offlineHarness?.manager?.storageUsage()))?.packages).toEqual([]);
  // Back online, the view falls back to the network.
  await page.evaluate(() => window.offlineHarness?.offline?.setMode('hybrid'));
  await page.evaluate(() => window.offlineHarness?.restartGlobe());
  expect(await emptyPixels(page)).toBe(0);
  expect(await servedPackages(page)).toEqual([]);
});

test('an install interrupted by closing the page resumes without downloading stored chunks again (F308)', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  await openHarness(page);
  const server = await servePackages(page);
  await startHarness(page, OFFLINE);
  const { manifestUrl, file } = await publishFixture(page, server, { ...ROME, chunkBytes: 2048 });
  const chunks = Math.ceil(file.length / 2048);
  void page.evaluate((url) => window.offlineHarness?.manager?.install(url), manifestUrl).catch(() => undefined);
  await expect
    .poll(() => server.requests.filter((r) => r.range).length, { timeout: 60_000 })
    .toBeGreaterThan(chunks / 2);
  await page.close();
  const first = server.requests.filter((r) => r.range).map((r) => r.range);

  const next = await context.newPage();
  await openHarness(next, { keepStorage: true });
  const nextServer = await servePackages(next);
  for (const [path, body] of server.files) nextServer.files.set(path, body);
  await startHarness(next, OFFLINE);
  const { error } = await install(next, manifestUrl);
  expect(error).toBeUndefined();
  const second = nextServer.requests.filter((r) => r.range).map((r) => r.range);
  expect(await next.evaluate(() => (window as unknown as { resumed: number }).resumed)).toBeGreaterThan(0);
  // Each chunk was downloaded once, except at most the one in flight when the page closed.
  const all = [...first, ...second];
  expect(new Set(all).size).toBe(chunks);
  expect(all.length - chunks).toBeLessThanOrEqual(1);
  // The stored file is the published one, byte for byte.
  const stored = await next.evaluate(
    () =>
      new Promise<string>((done) => {
        const open = indexedDB.open('vibeglobe-offline');
        open.onsuccess = () => {
          const request = open.result
            .transaction('package-files')
            .objectStore('package-files')
            .getAll(IDBKeyRange.bound('rome@1/', 'rome@1/￿'));
          request.onsuccess = async () => {
            const bytes = new Uint8Array(await new Blob(request.result as Blob[]).arrayBuffer());
            let binary = '';
            for (let i = 0; i < bytes.length; i += 0x8000)
              binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            done(btoa(binary));
          };
        };
      }),
  );
  expect(Buffer.from(stored, 'base64').equals(file)).toBe(true);
  expect(await emptyPixels(next)).toBe(0);
});

test('corruption of the header, a directory or tile data is detected on install and on read, and reads as missing (F309)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openHarness(page);
  const server = await servePackages(page);
  await startHarness(page, OFFLINE);
  const { file } = await publishFixture(page, server, { ...ROME, chunkBytes: 128 });
  const rootLength = Number(file.readBigUInt64LE(16));
  const cases = [
    { at: 3, part: 'header', not: undefined },
    { at: 127 + Math.min(150, rootLength - 2), part: 'root directory', not: 'header' },
    { at: file.length - 2, part: 'tile data', not: 'header' },
  ];
  for (const { at, part, not } of cases) {
    const id = `rome-${part.replace(' ', '-')}`;
    const corrupt = (bytes: Buffer): Buffer => {
      const copy = Buffer.from(bytes);
      copy[at] = (copy[at] ?? 0) ^ 0xff;
      return copy;
    };
    const { manifestUrl } = await publishFixture(page, server, { ...ROME, id, chunkBytes: 128 }, corrupt);
    const { error } = await install(page, manifestUrl);
    expect(error).toContain(part);
    if (not) expect(error).not.toContain(not);
    expect(await page.evaluate(() => window.offlineHarness?.manager?.list())).toEqual([]);
  }
  // Read in place from the LAN server: the damaged tile reads as missing, its ancestors show, nothing is black.
  await startHarness(page, { ...OFFLINE, served: ['/offline-fixtures/rome-tile-data/manifest.json'] });
  expect(await emptyPixels(page)).toBe(0);
  for (const zoom of [5, 6, 7]) expect(await viewAt(page, 12.5, 41.9, zoom)).toBe(0);
  expect((await page.evaluate(() => window.offlineHarness?.integrityErrors)) ?? []).toEqual(
    expect.arrayContaining([expect.stringContaining('SHA-256')]),
  );
  expect((await servedPackages(page)).length).toBeGreaterThan(5);
});

test('partial packages show what they have and cover the gaps with ancestors, never a blank frame (F310)', async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openHarness(page);
  const server = await servePackages(page);
  await startHarness(page, OFFLINE);
  const truncated = await publishFixture(
    page,
    server,
    { ...ROME, id: 'rome-partial', skipLevels: [4, 5], skip: ['7/69/47', '7/68/47'], chunkBytes: 256 },
    (bytes) => bytes.subarray(0, bytes.length - 100),
  );
  void truncated;
  await startHarness(page, { ...OFFLINE, served: ['/offline-fixtures/rome-partial/manifest.json'] });
  for (const zoom of [3, 4, 5, 6, 7, 8]) {
    const before = await page.evaluate(() => window.offlineHarness?.globe?.frameNumber ?? 0);
    expect(await viewAt(page, 12.5, 41.9, zoom)).toBe(0);
    expect(await page.evaluate(() => window.offlineHarness?.globe?.frameNumber ?? 0)).toBeGreaterThan(before);
  }
  const stats = await page.evaluate(() => window.offlineHarness?.globe?.surfaceStats());
  expect(stats?.fromAncestor).toBeGreaterThan(0);
  expect((await servedPackages(page)).length).toBeGreaterThanOrEqual(3);
});

test('in-browser builds honour the packaging switch per source and globally, and refuse forbidden sources before any download (F289, F319)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openHarness(page);
  const all = recordTileRequests(page);
  const builds = (): string[] => all.filter((path) => path.includes('/build-'));
  const area = { westDeg: 12.3, southDeg: 41.8, eastDeg: 12.7, northDeg: 42 };
  const google = { id: 'google', forbids: ['offlinePackaging' as const], respectCacheHeaders: true };
  await startHarness(page, {
    ...OFFLINE,
    network: 'hybrid',
    switchScopes: [{ switches: { offlinePackaging: false }, scope: { sourceId: 'roads' } }],
  });
  const base = { id: 'area', version: '1', area, minLevel: 0, maxLevel: 9 };
  const forbidden = await page.evaluate((r) => window.offlineHarness?.buildArea(r), {
    ...base,
    sources: [
      { id: 'imagery', pattern: 'world', session: 'build-imagery' },
      { id: 'google', pattern: 'levels', session: 'build-google', rules: google },
    ],
  });
  expect(forbidden?.error).toMatch(/source 'google'.*profile 'google' forbids offline packaging/);
  expect(builds()).toEqual([]);
  const built = await page.evaluate((r) => window.offlineHarness?.buildArea(r), {
    ...base,
    sources: [
      { id: 'imagery', pattern: 'world', session: 'build-imagery' },
      { id: 'roads', pattern: 'levels', session: 'build-roads' },
    ],
  });
  expect(built?.report?.included).toEqual(['imagery']);
  expect(built?.report?.excluded).toEqual([
    { sourceId: 'roads', reason: 'offline packaging is switched off for this source' },
  ]);
  expect(built?.tiles).toBeGreaterThan(9);
  expect(builds().length).toBe(built?.tiles);
  expect(builds().every((path) => path.includes('/build-imagery/'))).toBe(true);
  await page.evaluate(() => window.offlineHarness?.offline?.setSwitches({ offlinePackaging: false }));
  const refused = await page.evaluate((r) => window.offlineHarness?.buildArea(r), {
    ...base,
    id: 'other',
    sources: [{ id: 'imagery', pattern: 'world', session: 'build-imagery' }],
  });
  expect(refused?.error).toContain('offline packaging is switched off globally');
});
