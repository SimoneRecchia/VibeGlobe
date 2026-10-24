// The network chaos scenarios of F510, shared by its default spec and its known-bug spec: random navigation while a
// fault injector fails, delays, truncates and corrupts responses, with every frame recorded and checked in the page
// (the network suite's recorder, ADR 0151) and every error collected. Raster tiles from the network and an offline
// package read from a LAN server, in the offline harness; vector tile styles, tiles and glyphs, in the playground.
// Once the base has loaded no frame is blank, the frames keep coming and nothing throws uncaught; with `recovery`,
// the view also returns to full detail after the faults stop (TG-04, TG-05 until fixed).
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { BLACK_BELOW, HEALTH, STEP_MS, romeDetail, worldBase } from '../../network/support/scenarios.ts';
import { recordPath, ROME, sessionId } from '../../network/support/network.ts';
import { canvasImage, expectCompleteGlobe, openGlobe, waitForIdle } from '../../support/globe.ts';
import { openHarness, publishFixture, startHarness } from '../../support/offline.ts';
import { injectChaos, randomPath, serveFaultyPackages, type Fault } from './chaos.ts';
import { collectErrors, runSeed, scaled, seeded, unexpected } from './probes.ts';

const BACKENDS = ['webgpu', 'webgl2'] as const;
type Backend = (typeof BACKENDS)[number];
/**
 * Console errors the browser itself prints for the injected failures ("Failed to load resource" for a 500 or a reset);
 * an engine error would carry the engine's prefix and is not allowed.
 */
const INJECTED = [/Failed to load resource/, /net::ERR_/];
const STYLE = '**/vector-tiles/styles/streets.json';
const VECTOR_PAGE = `/@fs${resolve('e2e/robustness/support/vector-page.ts')}`;

/** Adds the fixture streets style to the page's globe as a host does; resolves with 'ok' or the error's text. */
async function addStyle(page: Page): Promise<string> {
  return page.evaluate(async (url) => {
    const module = (await import(/* @vite-ignore */ url)) as typeof import('./vector-page.ts');
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) throw new Error('no globe');
    return module.addStyle(globe, '/vector-tiles/styles/streets.json');
  }, VECTOR_PAGE);
}

/** The share of pixels whose color differs by more than 24 in a channel. */
function changedFraction(a: PNG, b: PNG): number {
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4)
    for (let c = 0; c < 3; c++)
      if (Math.abs((a.data[i + c] ?? 0) - (b.data[i + c] ?? 0)) > 24) {
        changed++;
        break;
      }
  return changed / (a.width * a.height);
}

const PLACES = [ROME, { longitudeDeg: 2.35, latitudeDeg: 48.85 }, { longitudeDeg: 13.4, latitudeDeg: 52.5 }];

/**
 * Waits until no imagery tile is queued, loading or decoding and every drawn tile shows its own level. The harness runs
 * on the manual clock (one step per drawn frame), so each poll draws 30 frames: half a second of engine time for the
 * loaders' retries and backoffs.
 */
async function expectFullDetail(page: Page, what: string): Promise<void> {
  let last: unknown;
  await expect
    .poll(
      async () =>
        (last = await page.evaluate(async () => {
          const globe = window.offlineHarness?.globe;
          for (let i = 0; i < 30; i++) {
            globe?.requestRender();
            await new Promise((resolve) => requestAnimationFrame(resolve));
          }
          const imagery = globe?.imageryStats();
          const surface = globe?.surfaceStats();
          return {
            failed: imagery?.failed,
            noData: imagery?.noData,
            queued: imagery?.queued,
            loading: imagery?.loading,
            decoding: imagery?.decoding,
            connectivity: window.offlineHarness?.offline?.connectivity,
            pending: imagery ? imagery.queued + imagery.loading + imagery.decoding + imagery.uploadsPending : -1,
            fromAncestor: surface?.fromAncestor ?? -1,
            onBaseImage: surface?.onBaseImage ?? -1,
          };
        })),
      { timeout: 120_000, intervals: [100], message: what },
    )
    .toMatchObject({ pending: 0, fromAncestor: 0, onBaseImage: 0 })
    .finally(() => console.log(`[robustness] ${what}: ${JSON.stringify(last)}`));
}

/** Starts the offline harness on `backend` with the base installed, a LAN package and the injector on its tiles. */
async function startRaster(page: Page, backend: Backend, random: () => number) {
  const session = sessionId(`chaos-${backend}`);
  const sources = [{ id: 'world', pattern: 'world', session }];
  await openHarness(page);
  const lan = await serveFaultyPackages(page, random, 'corrupted');
  lan.chaos.enabled = false;
  // The base: the world package to level 3, installed; Rome's detail package on the LAN server; the rest online.
  await startHarness(page, { sources, view: ROME, backend });
  await page.evaluate((s) => window.offlineHarness?.installFixture(s), worldBase(session));
  const detail = await publishFixture(page, lan.server, romeDetail(session));
  const tiles = await injectChaos(page, `**/fixture-tiles/${session}/**`, random);
  tiles.enabled = false;
  // The package is read when the harness starts (its manifest, header and directories): the faults are on for it.
  lan.chaos.enabled = true;
  const config = { sources, view: ROME, backend, healthChecks: HEALTH, clockStepMs: STEP_MS };
  await startHarness(page, { ...config, served: [detail.manifestUrl] });
  return { lan: lan.chaos, tiles };
}

const faultCount = (counts: Record<Fault, number>): number =>
  Object.entries(counts).reduce((sum, [fault, n]) => sum + (fault === 'pass' ? 0 : n), 0);

/** The raster scenario: faults on tiles and the LAN package during a random path of frame-stepped navigation. */
async function rasterChaos(page: Page, backend: Backend, recovery: boolean): Promise<void> {
  const seed = runSeed();
  console.log(`[robustness] F510 raster ${backend} seed ${seed}`);
  const random = seeded(seed);
  const errors = await collectErrors(page);
  const { lan, tiles } = await startRaster(page, backend, random);
  const navigations = await page.evaluate(() => performance.getEntriesByType('navigation').length);
  // The control: without faults the criterion holds at a view the path never visits.
  await page.evaluate(() => window.offlineHarness?.globe?.jumpTo({ longitudeDeg: -70, latitudeDeg: -20, zoom: 7 }));
  await expectFullDetail(page, 'the control view, before the faults');
  tiles.enabled = true;
  const frames = await page.evaluate(() => window.offlineHarness?.globe?.frameNumber ?? 0);
  const report = await recordPath(page, randomPath(random, PLACES, scaled(30)), BLACK_BELOW);
  tiles.enabled = lan.enabled = false;
  console.log(
    `[robustness] F510 raster ${backend}: ${JSON.stringify({ report, tiles: tiles.counts, lan: lan.counts })}`,
  );
  // The injector really hit both kinds of response.
  expect(faultCount(tiles.counts)).toBeGreaterThan(10);
  expect(faultCount(lan.counts)).toBeGreaterThan(0);
  // No blank frame: no pixel inside the globe without imagery or black.
  expect([report.holes, report.dark], JSON.stringify(report.first)).toEqual([0, 0]);
  // No frozen frame: every frame of the path was drawn (each capture draws one), and the engine kept counting.
  const framesNow = await page.evaluate(() => window.offlineHarness?.globe?.frameNumber ?? 0);
  expect(framesNow).toBeGreaterThanOrEqual(frames + report.frames);
  // Full detail where the faults were, without moving: the view the path ended on.
  if (recovery) await expectFullDetail(page, 'the last view of the path, after the faults stopped');
  expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(navigations);
  expect(unexpected(errors, INJECTED)).toEqual([]);
}

const VECTOR_QUERY = (backend: string): string => `backend=${backend}&imagery=world&lon=9.19&lat=45.465&zoom=12`;
/** The view compared: never visited before the faults, so its tiles cannot come from a cache. */
const VECTOR_TARGET = { longitudeDeg: 9.2, latitudeDeg: 45.47, zoom: 13.5 };

/** Jumps to the compared view and waits until its vector tiles are laid out and drawn. */
async function settleVector(page: Page): Promise<void> {
  await page.evaluate((v) => window.vibeglobePlayground?.globe.jumpTo(v), VECTOR_TARGET);
  for (let i = 0; i < 2; i++) {
    await page.waitForFunction(() => window.robustnessVectorLayer?.loadingTiles() === 0, null, { timeout: 90_000 });
    await waitForIdle(page);
  }
}

/** The compared view in a page that never saw a fault. */
async function vectorReference(context: BrowserContext, backend: string): Promise<PNG> {
  const clean = await context.newPage();
  await openGlobe(clean, VECTOR_QUERY(backend));
  expect(await addStyle(clean)).toBe('ok');
  await settleVector(clean);
  const reference = await canvasImage(clean);
  await clean.close();
  return reference;
}

/** The vector scenario: faults on vector tiles and glyphs during random eases around Milan. */
async function vectorChaos(page: Page, context: BrowserContext, backend: string, recovery: boolean): Promise<void> {
  const seed = runSeed();
  console.log(`[robustness] F510 vector ${backend} seed ${seed}`);
  const random = seeded(seed);
  const reference = recovery ? await vectorReference(context, backend) : undefined;
  const errors = await collectErrors(page);
  await openGlobe(page, VECTOR_QUERY(backend));
  expect(await addStyle(page)).toBe('ok');
  const chaos = await injectChaos(page, /\/vector-tiles\/(?!styles\/)/, random);
  for (let i = 0; i < scaled(40); i++) {
    const view = {
      longitudeDeg: 9.19 + (random() - 0.5) * 0.2,
      latitudeDeg: 45.465 + (random() - 0.5) * 0.1,
      zoom: 11 + random() * 4,
    };
    await page.evaluate((v) => window.vibeglobePlayground?.globe.easeTo(v, { durationMs: 300 }), view);
    await page.waitForTimeout(random() * 400);
  }
  chaos.enabled = false;
  console.log(`[robustness] F510 vector ${backend}: ${JSON.stringify(chaos.counts)}`);
  expect(faultCount(chaos.counts)).toBeGreaterThan(0);
  await expectCompleteGlobe(page);
  if (reference) {
    await settleVector(page);
    const after = await canvasImage(page);
    const changed = changedFraction(reference, after);
    if (changed >= 0.01) {
      await writeFile(test.info().outputPath('reference.png'), PNG.sync.write(reference));
      await writeFile(test.info().outputPath('after.png'), PNG.sync.write(after));
    }
    // Full detail again: the same frame as a page that never saw a fault, but for anti-aliasing and label fades.
    expect(changed).toBeLessThan(0.01);
  }
  expect(unexpected(errors, INJECTED)).toEqual([]);
}

/** Registers the raster and vector chaos scenarios on both backends; `recovery` adds the full-detail checks. */
export function networkChaosTests(recovery: boolean): void {
  test.use({ viewport: { width: 320, height: 240 } });
  const after = recovery ? 'full detail after the faults stop' : 'the globe complete';
  for (const backend of BACKENDS) {
    test(`random faults on tiles and a LAN package during random navigation on ${backend}: no blank or frozen frame, no uncaught error, ${after} (F510)`, async ({
      page,
    }) => {
      test.setTimeout(600_000);
      await rasterChaos(page, backend, recovery);
    });
    test(`random faults on vector tiles and glyphs during navigation on ${backend}: no uncaught error, ${after} (F510)`, async ({
      page,
      context,
    }) => {
      test.setTimeout(600_000);
      await vectorChaos(page, context, backend, recovery);
    });
  }
}

/** Registers the style-fault scenario on both backends. */
export function styleFaultTests(): void {
  test.use({ viewport: { width: 320, height: 240 } });
  for (const backend of BACKENDS) {
    test(`a failed, truncated or corrupted vector style is reported without an uncaught error and the globe keeps drawing on ${backend} (F510)`, async ({
      page,
    }) => {
      test.setTimeout(300_000);
      const errors = await collectErrors(page);
      await openGlobe(page, `backend=${backend}&imagery=world&lon=9.19&lat=45.465&zoom=12`);
      for (const fault of ['reset', 'error-500', 'truncated', 'corrupted'] as const) {
        let answered = 0;
        await page.route(STYLE, async (route) => {
          answered++;
          if (fault === 'reset') return route.abort('connectionreset');
          if (fault === 'error-500') return route.fulfill({ status: 500, body: 'injected failure' });
          const body = await (await route.fetch()).body();
          const altered =
            fault === 'truncated'
              ? body.subarray(0, body.length >> 1)
              : Buffer.from(body.toString().replace(/"/g, "'"));
          return route.fulfill({ status: 200, contentType: 'application/json', body: altered });
        });
        expect(await addStyle(page), fault).not.toBe('ok');
        expect(answered, fault).toBeGreaterThan(0);
        await expectCompleteGlobe(page);
        await page.unroute(STYLE);
      }
      // Without faults the same page then loads the style.
      expect(await addStyle(page)).toBe('ok');
      expect(unexpected(errors, INJECTED)).toEqual([]);
    });
  }
}
