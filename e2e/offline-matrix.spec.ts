// The matrix of network modes and loading switches (F314), M8 track B: every combination of network mode (online
// only, offline only, hybrid) and the four switches (persistent cache, memory reuse, prefetch and flight preloading,
// offline packaging), each with an unrestricted source and a source whose profile forbids the persistent cache,
// prefetch and packaging; the combinations that read packages run with packages in browser storage and on a LAN
// server. A short zoom, pan and flight per combination, with request interception and storage inspection, on WebGPU and
// on forced WebGL2, with no pixel popping in the frames of a still camera (F329 step 3, KB-188).
import { expect, test, type Page } from '@playwright/test';
import { nextFrame } from './support/globe.ts';
import {
  emptyPixelsMoving,
  openHarness,
  publishFixture,
  recordTileRequests,
  servePackages,
  startHarness,
  storedTileKeys,
  tileHeaders,
  type HarnessConfig,
} from './support/offline.ts';
import { recordPath } from './network/support/network.ts';

test.use({ viewport: { width: 320, height: 240 } });

type Switches = { persistentCache: boolean; memoryReuse: boolean; prefetch: boolean; offlinePackaging: boolean };
type Mode = 'online' | 'offline' | 'hybrid';
type Bounds = [number, number, number, number];

const NAMES = ['persistentCache', 'memoryReuse', 'prefetch', 'offlinePackaging'] as const;
const COMBINATIONS: Switches[] = Array.from({ length: 16 }, (_, bits) => ({
  persistentCache: (bits & 1) !== 0,
  memoryReuse: (bits & 2) !== 0,
  prefetch: (bits & 4) !== 0,
  offlinePackaging: (bits & 8) !== 0,
}));
const RESTRICTIVE = { id: 'strict-provider', forbids: ['persistentCache', 'prefetch', 'offlinePackaging'] as const };
const ROME = { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 8 };
/** Where the scenario's flight ends; the memory-reuse check comes back to it. */
const LAST_VIEW = { longitudeDeg: 12.2, latitudeDeg: 41.7, zoom: 9 };
const PACKAGE = {
  id: 'rome',
  sourceId: 'open',
  pattern: 'world',
  bounds: { westDeg: 10.5, southDeg: 40.5, eastDeg: 14.5, northDeg: 43.3 },
  minLevel: 0,
  maxLevel: 10,
  version: '1',
};

function tileOf(path: string): [number, number, number] {
  const [z = 0, x = 0, y = 0] = /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(path)?.slice(1).map(Number) ?? [];
  return [z, x, y];
}

function boundsOf([z, x, y]: [number, number, number]): Bounds {
  const n = 2 ** z;
  const lat = (row: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return [(x / n) * 360 - 180, lat(y + 1), ((x + 1) / n) * 360 - 180, lat(y)];
}

const overlaps = (a: Bounds, b: Bounds): boolean =>
  a[0] < b[2] - 1e-9 && b[0] < a[2] - 1e-9 && a[1] < b[3] - 1e-9 && b[1] < a[3] - 1e-9;

/** Empties the persistent tile store, keeping the installed packages. */
async function clearTiles(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        const open = indexedDB.open('vibeglobe-offline');
        open.onerror = () => done();
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('tiles')) {
            db.close();
            done();
            return;
          }
          const transaction = db.transaction('tiles', 'readwrite');
          transaction.objectStore('tiles').clear();
          transaction.oncomplete = transaction.onerror = () => {
            db.close();
            done();
          };
        };
      }),
  );
}

/** Records the bounds of every surface tile drawn from now on. */
async function recordDrawn(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen = new Map<string, [number, number, number, number]>();
    (window as unknown as { drawn: typeof seen }).drawn = seen;
    const globe = window.offlineHarness?.globe;
    globe?.on('frame', () => {
      for (const t of globe.surfaceTiles())
        seen.set(`${t.level}/${t.x}/${t.y}`, [t.westDeg, t.southDeg, t.eastDeg, t.northDeg]);
    });
  });
}

/**
 * A short scenario: a zoom, a pan, a one-second flight and a settled view; the most empty pixels seen, and the pixels
 * that popped in frames of a still camera while tiles arrived (F329 step 3).
 */
async function scenario(page: Page): Promise<{ worst: number; pops: number }> {
  let worst = 0;
  let pops = 0;
  for (const view of [ROME, { ...ROME, zoom: 9 }, { ...ROME, longitudeDeg: 12.8, zoom: 9 }]) {
    await page.evaluate((v) => window.offlineHarness?.globe?.jumpTo(v), view);
    await nextFrame(page);
    worst = Math.max(worst, await emptyPixelsMoving(page));
    pops += (await recordPath(page, [{ hold: 8 }], 0)).pops;
  }
  await page.evaluate((v) => {
    void window.offlineHarness?.globe?.flyTo(v, { durationMs: 1000 });
  }, LAST_VIEW);
  for (let k = 0; k < 4; k++) {
    await nextFrame(page);
    worst = Math.max(worst, await emptyPixelsMoving(page));
  }
  await page.waitForTimeout(2000);
  pops += (await recordPath(page, [{ hold: 20 }], 0)).pops;
  return { worst: Math.max(worst, await emptyPixelsMoving(page)), pops };
}

/** Runs the 16 switch combinations in one mode and package setup, checking each against the specification. */
async function runMatrix(
  page: Page,
  mode: Mode,
  setup: 'stored' | 'lan' | 'none',
  backend: 'webgpu' | 'webgl2',
): Promise<void> {
  await openHarness(page);
  await tileHeaders(page, () => ({ 'Cache-Control': 'max-age=86400' }));
  const lan = setup === 'lan' ? await servePackages(page) : undefined;
  // The setup engine (it installs the package) has its own source id, so its late cache writes are not the open source's.
  await startHarness(page, { sources: [{ id: 'setup', pattern: 'world', session: 'f314' }], view: ROME });
  const served: string[] = [];
  if (setup === 'stored')
    await page.evaluate((s) => window.offlineHarness?.installFixture(s), { ...PACKAGE, session: 'f314' });
  if (lan) served.push((await publishFixture(page, lan, { ...PACKAGE, session: 'f314' })).manifestUrl);
  const requests = recordTileRequests(page);
  const failures: string[] = [];
  for (const [index, switches] of COMBINATIONS.entries()) {
    const label = `${mode}/${setup} ${NAMES.filter((n) => switches[n]).join('+') || 'all off'}`;
    const fail = (what: string): void => void failures.push(`${label}: ${what}`);
    // A fresh persistent cache and fresh sessions per combination, so nothing carries over: the previous engine stops,
    // its last cache writes land, and the tile store is emptied (the installed packages stay).
    await page.evaluate(() => window.offlineHarness?.stop());
    await page.waitForTimeout(500);
    await clearTiles(page);
    const sessions = {
      open: `f314-${backend}-${mode}-${setup}-${String(index)}`,
      strict: `f314s-${backend}-${mode}-${setup}-${String(index)}`,
    };
    const config: HarnessConfig = {
      backend,
      network: mode,
      switches,
      sources: [
        { id: 'open', pattern: 'world', session: sessions.open },
        {
          id: 'strict',
          pattern: 'levels',
          session: sessions.strict,
          minLevel: 5,
          profile: { ...RESTRICTIVE, forbids: [...RESTRICTIVE.forbids], respectCacheHeaders: true },
        },
      ],
      served,
      view: ROME,
      healthChecks: { minIntervalMs: 300, maxIntervalMs: 2000 },
      // One engine step per drawn frame, so a cross-fade between two recorded frames is not read as a pop.
      clockStepMs: 1000 / 60,
      awaitReady: mode !== 'offline',
    };
    const from = requests.length;
    await startHarness(page, config);
    await recordDrawn(page);
    const { worst, pops } = await scenario(page);
    const drawn = await page.evaluate(() => [...(window as unknown as { drawn: Map<string, Bounds> }).drawn.values()]);
    // This combination's own sources only (the previous engine may still finish its last requests).
    const sent = requests
      .slice(from)
      .filter((p) => p.includes(`/${sessions.open}/`) || p.includes(`/${sessions.strict}/`));
    const ofSource = (id: 'open' | 'strict') => sent.filter((p) => p.includes(`/${sessions[id]}/`));
    const beyond = (paths: string[]) =>
      paths.filter((p) => tileOf(p)[0] >= 5 && !drawn.some((b) => overlaps(boundsOf(tileOf(p)), b)));
    const tiers = await page.evaluate(() =>
      (window.offlineHarness?.served ?? []).map((e) => ({ source: e.sourceId, tier: e.tier })),
    );
    const effective = await page.evaluate(
      () =>
        ({
          open: window.offlineHarness?.offline?.effectiveSwitches('open'),
          strict: window.offlineHarness?.offline?.effectiveSwitches('strict'),
        }) as Record<'open' | 'strict', Switches>,
    );

    // The rules: a profile only switches off; the mode decides the network and the packages.
    for (const name of NAMES) {
      if (effective.open[name] !== switches[name]) fail(`open ${name} is ${String(effective.open[name])}`);
      const strict = switches[name] && !(RESTRICTIVE.forbids as readonly string[]).includes(name);
      if (effective.strict[name] !== strict) fail(`strict ${name} is ${String(effective.strict[name])}`);
    }
    if (worst > 0) fail(`${String(worst)} empty pixels`);
    if (pops > 0) fail(`${String(pops)} popped pixels`);
    // Network: none at all offline; online and hybrid fetch what they need.
    if (mode === 'offline' && sent.length > 0) fail(`${String(sent.length)} requests offline`);
    if (mode !== 'offline' && ofSource('strict').length === 0) fail('no request for the strict source');
    // Packages: read in offline and hybrid modes, never online.
    const packageReads = tiers.filter((t) => t.tier === 'package').length;
    if (mode === 'online' && packageReads > 0) fail('package read online');
    if (mode !== 'online' && setup !== 'none' && packageReads === 0) fail('no package read');
    // Prefetch: tiles beyond the drawn views only where the effective switch allows it, never for the strict source.
    if (mode !== 'offline') {
      if (beyond(ofSource('strict')).length > 0) fail('strict source prefetched');
      if (!switches.prefetch && beyond(ofSource('open')).length > 0) fail('open source prefetched with prefetch off');
    }
    // Persistent cache: written only where the effective switch allows it, never for the strict source.
    await page.waitForTimeout(300);
    const stored = await storedTileKeys(page);
    if (stored.some((k) => k.startsWith('strict/'))) fail('strict source persisted');
    const openStored = stored.filter((k) => k.startsWith('open/')).length;
    if (!switches.persistentCache && openStored > 0) fail('open source persisted with the cache off');
    if (switches.persistentCache && mode !== 'offline' && setup === 'none' && openStored === 0)
      fail('open source not persisted');
    // Memory reuse: a revisit is drawn without a delivery only when the switch keeps tiles.
    if (mode !== 'offline') {
      const before = tiers.filter((t) => t.source === 'open').length;
      await page.evaluate((v) => window.offlineHarness?.globe?.jumpTo(v), { ...ROME, longitudeDeg: 30 });
      await page.waitForTimeout(1500);
      await page.evaluate((v) => window.offlineHarness?.globe?.jumpTo(v), LAST_VIEW);
      await page.waitForTimeout(1500);
      // Tiles of the open source drawn in the scenario and delivered a second time since (the same coordinates).
      const again = await page.evaluate((i) => {
        const served = (window.offlineHarness?.served ?? []).filter((e) => e.sourceId === 'open');
        const key = (e: (typeof served)[number]) =>
          `${String(e.coord.level)}/${String(e.coord.x)}/${String(e.coord.y)}`;
        // Memory reuse keeps tiles that were used on screen (F281); prefetched tiles no frame drew are the loader's.
        const drawn = (window as unknown as { drawn: Map<string, unknown> }).drawn;
        const earlier = new Set(
          served
            .slice(0, i)
            .map(key)
            .filter((k) => drawn.has(k)),
        );
        const repeated = served.slice(i).filter((e) => earlier.has(key(e)));
        return { count: repeated.length, tiles: repeated.map((e) => `${key(e)} ${e.tier}`) };
      }, before);
      if (switches.memoryReuse && again.count > 0)
        fail(`open tiles delivered again with memory reuse: ${again.tiles.join(', ')}`);
      if (!switches.memoryReuse && again.count === 0) fail('nothing delivered again without memory reuse');
    }
    // Packaging: allowed by the switch for the open source, never for the strict one.
    if (mode !== 'offline') {
      const area = { westDeg: 12.45, southDeg: 41.88, eastDeg: 12.55, northDeg: 41.92 };
      const build = async (id: 'open' | 'strict') =>
        page.evaluate((r) => window.offlineHarness?.buildArea(r), {
          id: `pkg-${id}-${String(index)}`,
          version: '1',
          area,
          minLevel: 0,
          maxLevel: 3,
          sources: [
            id === 'open'
              ? { id: 'open', pattern: 'world', session: sessions.open }
              : {
                  id: 'strict',
                  pattern: 'levels',
                  session: sessions.strict,
                  rules: { id: RESTRICTIVE.id, forbids: [...RESTRICTIVE.forbids], respectCacheHeaders: true },
                },
          ],
        });
      const open = await build('open');
      if (switches.offlinePackaging === (open?.error !== undefined))
        fail(`packaging the open source: ${open?.error ?? 'built'}`);
      const strict = await build('strict');
      if (strict?.error === undefined) fail('the strict source was packaged');
      await page.evaluate(
        async (ids) => {
          for (const id of ids) await window.offlineHarness?.manager?.remove(id).catch(() => undefined);
        },
        [`pkg-open-${String(index)}`],
      );
    }
  }
  expect(failures).toEqual([]);
}

for (const backend of ['webgpu', 'webgl2'] as const)
  for (const [mode, setup] of [
    ['online', 'none'],
    ['offline', 'stored'],
    ['offline', 'lan'],
    ['hybrid', 'stored'],
    ['hybrid', 'lan'],
  ] as const)
    test(`every switch combination behaves as specified in ${mode} mode${setup === 'none' ? '' : ` with packages ${setup === 'lan' ? 'on a LAN server' : 'in browser storage'}`} on ${backend} (F314, F329)`, async ({
      page,
    }) => {
      test.setTimeout(900_000);
      await runMatrix(page, mode, setup, backend);
    });
