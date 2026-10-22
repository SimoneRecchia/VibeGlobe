import { expect, test, type Page } from '@playwright/test';
import { canvasImage, emptyPixelsInside, nextFrame, openGlobe, silhouetteRadiusPx } from './support/globe.js';
import { fixtureSession, requestLog, waitForImagery } from './support/imagery.js';

/** M3 increment 4: the pinned base, the RAM tier, memory budgets and uploads (ADR 0007). */

test.describe.configure({ timeout: 180_000 });

const ROME = { lon: 12.5, lat: 41.9 };
const TOKYO = { lon: 139.7, lat: 35.7 };
const NEW_YORK = { lon: -74, lat: 40.7 };
const CITIES = [ROME, TOKYO, NEW_YORK, { lon: 151.2, lat: -33.9 }, { lon: 31.2, lat: 30 }, { lon: -43.2, lat: -22.9 }];

type Stats = NonNullable<ReturnType<NonNullable<Window['vibeglobePlayground']>['globe']['imageryStats']>>;

async function stats(page: Page): Promise<Stats> {
  const value = await page.evaluate(() => window.vibeglobePlayground?.globe.imageryStats());
  if (!value) throw new Error('no imagery stats');
  return value;
}

async function flyTo(page: Page, view: { lon: number; lat: number; zoom: number }): Promise<void> {
  await page.evaluate(
    (v) => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: v.lon, latitudeDeg: v.lat, zoom: v.zoom }),
    view,
  );
  // The tiles of the frame drawn for the new view, not those of the last frame of the old one.
  await nextFrame(page);
  await waitForImagery(page);
}

/** Records, at every drawn frame, the imagery counters and the imagery level each drawn tile shows. */
async function startRecording(page: Page): Promise<void> {
  await page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    const frames: { stats: unknown; tiles: Record<string, number> }[] = [];
    (window as unknown as { recorded: typeof frames }).recorded = frames;
    globe?.on('frame', () => {
      const tiles: Record<string, number> = {};
      for (const tile of globe.surfaceTiles())
        tiles[`${tile.root}/${tile.level}/${tile.x}/${tile.y}`] = tile.imageryLevel ?? -1;
      frames.push({ stats: globe.imageryStats(), tiles });
    });
  });
}

async function recorded(page: Page): Promise<{ stats: Stats; tiles: Record<string, number> }[]> {
  return page.evaluate(
    () => (window as unknown as { recorded: { stats: Stats; tiles: Record<string, number> }[] }).recorded,
  );
}

test('the pinned base loads before refinement, is never evicted, and makes zooming out complete at once (F084)', async ({
  page,
}) => {
  const session = await fixtureSession(page);
  // A 24 MB GPU budget pins levels 0 and 1 (3 MB of 256 px tiles) and forces evictions below.
  await openGlobe(page, `imagery=levels&session=${session}&zoom=2&gpuBudgetMB=24&ramBudgetMB=8`);
  const log = await requestLog(page, session);
  const pinned = log.filter((request) => request.level <= 1);
  expect(pinned).toHaveLength(5);
  const lastPinned = Math.max(...pinned.map((request) => request.endMs ?? Infinity));
  for (const request of log.filter((r) => r.level > 1)) expect(request.startMs).toBeGreaterThanOrEqual(lastPinned);
  await waitForImagery(page);
  for (const city of CITIES) {
    await flyTo(page, { ...city, zoom: 9 });
    if ((await stats(page)).evicted > 0) break;
  }
  expect((await stats(page)).evicted).toBeGreaterThan(0);
  // Zoom out to the whole globe: the very first frame is complete, drawn from the pinned base.
  await startRecording(page);
  await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ zoom: 1.5 }));
  await nextFrame(page);
  const radius = await silhouetteRadiusPx(page);
  expect(emptyPixelsInside(await canvasImage(page), radius)).toBe(0);
  const first = (await recorded(page))[0];
  expect(first).toBeDefined();
  for (const [key, imageryLevel] of Object.entries(first?.tiles ?? {}))
    if (key.startsWith('mercator')) expect(imageryLevel, key).toBeGreaterThanOrEqual(0);
  await waitForImagery(page);
  expect((await requestLog(page, session)).filter((request) => request.level <= 1)).toHaveLength(5);
  expect((await stats(page)).pinnedSettled).toBe(5);
});

test('tiles evicted from the GPU come back from the RAM tier without a new request, counted in the overlay (F097)', async ({
  page,
}) => {
  const session = await fixtureSession(page);
  await openGlobe(page, `imagery=levels&session=${session}&zoom=2&gpuBudgetMB=24&ramBudgetMB=64&debug=1`);
  await waitForImagery(page);
  await flyTo(page, { ...ROME, zoom: 9 });
  const romeRequests = (await requestLog(page, session)).length;
  await flyTo(page, { ...TOKYO, zoom: 9 });
  await flyTo(page, { ...NEW_YORK, zoom: 9 });
  expect((await stats(page)).evicted).toBeGreaterThan(0);
  const before = await stats(page);
  const requestsBefore = (await requestLog(page, session)).length;
  await flyTo(page, { ...ROME, zoom: 9 });
  const after = await stats(page);
  // Every tile of the returning view was requested before, and none is requested again.
  const log = await requestLog(page, session);
  expect(log.length).toBe(requestsBefore);
  expect(new Set(log.map((request) => request.path)).size).toBe(log.length);
  expect(romeRequests).toBeGreaterThan(0);
  expect(after.ramHits).toBeGreaterThan(before.ramHits);
  await expect(page.locator('.vibeglobe-debug-overlay')).toContainText(`RAM hits ${after.ramHits}`);
});

test('GPU and RAM use stay within their budgets, and no tile on screen loses its imagery to an eviction (F098)', async ({
  page,
}) => {
  const session = await fixtureSession(page);
  await openGlobe(page, `imagery=levels&session=${session}&zoom=2&gpuBudgetMB=20&ramBudgetMB=3`);
  await waitForImagery(page);
  await startRecording(page);
  for (const city of CITIES) {
    await flyTo(page, { ...city, zoom: 8 });
    await flyTo(page, { ...city, zoom: 10 });
  }
  const frames = await recorded(page);
  expect(frames.length).toBeGreaterThan(20);
  for (const frame of frames) {
    expect(frame.stats.gpuBytes).toBeLessThanOrEqual(frame.stats.gpuBudgetBytes);
    expect(frame.stats.ramBytes).toBeLessThanOrEqual(frame.stats.ramBudgetBytes);
  }
  expect(frames.at(-1)?.stats.evicted).toBeGreaterThan(0);
  // A tile drawn in two successive frames never falls back to coarser imagery: what is on screen is not evicted.
  for (let i = 1; i < frames.length; i++) {
    const previous = frames[i - 1]?.tiles ?? {};
    for (const [key, level] of Object.entries(frames[i]?.tiles ?? {})) {
      const before = previous[key];
      if (before !== undefined) expect(level, `${key} in frame ${i}`).toBeGreaterThanOrEqual(before);
    }
  }
});

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(`a burst of arrivals uploads within the per-frame budget, each tile once, none again when re-shown on ${backend} (F101, F102)`, async ({
    page,
  }) => {
    // The tab can be hidden: with no frames, tiles that arrive wait for upload, a burst for the frames after it shows.
    await page.addInitScript(() => {
      let visibility: DocumentVisibilityState = 'visible';
      Object.defineProperty(document, 'visibilityState', { get: () => visibility });
      (window as unknown as { setVisibility: (state: DocumentVisibilityState) => void }).setVisibility = (state) => {
        visibility = state;
        document.dispatchEvent(new Event('visibilitychange'));
      };
    });
    const session = await fixtureSession(page);
    await openGlobe(page, `backend=${backend}&imagery=levels&session=${session}&zoom=2`);
    await waitForImagery(page);
    const textureUploads = (): Promise<number> =>
      page.evaluate(() => window.vibeglobePlayground?.globe.rendererStats().textureUploads ?? 0);
    const rendererBefore = await textureUploads();
    const before = await stats(page);
    const imageryBefore = before.uploads;
    await page.evaluate(() => window.vibeglobePlayground?.globe.diagnostics.setPhaseTiming(true, false));
    await startRecording(page);
    // A burst of arrivals, whatever the runner's frame rate: the first frame at Tokyo requests its tiles, they arrive
    // and decode while the tab is hidden, and all of them wait for the frames after it shows again.
    await page.evaluate(
      (v) => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: v.lon, latitudeDeg: v.lat, zoom: 9 }),
      TOKYO,
    );
    await nextFrame(page);
    await page.evaluate(() => (window as unknown as { setVisibility: (s: string) => void }).setVisibility('hidden'));
    await expect.poll(() => page.evaluate(() => window.vibeglobePlayground?.globe.imageryStats()?.loading)).toBe(0);
    await page.evaluate(() => (window as unknown as { setVisibility: (s: string) => void }).setVisibility('visible'));
    await nextFrame(page);
    await waitForImagery(page);
    const frames = await recorded(page);
    for (const [i, frame] of frames.entries()) {
      expect(frame.stats.uploadBytesLastFrame).toBeLessThanOrEqual(8_000_000);
      // A tile still waiting after a frame is uploaded by the next one: the queue drains in a bounded number of frames.
      const next = frames[i + 1];
      if (frame.stats.uploadsPending > 0 && next) expect(next.stats.uploads).toBeGreaterThan(frame.stats.uploads);
    }
    const timings = frames.map((frame) => frame.stats.uploadMsLastFrame).filter((ms) => ms > 0);
    console.log(`upload ms per frame on ${backend}: ${timings.map((ms) => ms.toFixed(1)).join(' ')}`);
    // Every burst of arrivals drains within 15 frames (docs/plan/quality.md): no 16 frames in a row with a tile waiting.
    let waiting = 0;
    for (const frame of frames) {
      waiting = frame.stats.uploadsPending > 0 ? waiting + 1 : 0;
      expect(waiting).toBeLessThanOrEqual(15);
    }
    expect(Math.max(...frames.map((frame) => frame.stats.uploadsPending + 1))).toBeGreaterThan(1);
    // CPU time per frame, from the engine's phase timing (recorded; on the software GPU times are not judged, ADR 0012).
    const cpu = await page.evaluate(() => window.vibeglobePlayground?.globe.diagnostics.phaseTimesMs());
    console.log(`CPU phases of the last frame on ${backend}: ${JSON.stringify(cpu)}`);
    // Each resident tile is uploaded once (F102): every upload made one more tile resident, none was evicted or came
    // back from RAM to be uploaded again, no tile was fetched twice, and three.js uploaded nothing else.
    const after = await stats(page);
    const uploaded = after.uploads - imageryBefore;
    expect(uploaded).toBeGreaterThan(0);
    expect(after.ready - before.ready).toBe(uploaded);
    expect(after.evicted).toBe(0);
    expect(after.ramHits).toBe(0);
    const log = await requestLog(page, session);
    expect(new Set(log.map((request) => request.path)).size).toBe(log.length);
    expect((await textureUploads()) - rendererBefore).toBe(uploaded);
    // Away and back within the budget: the resident tiles are shown again without an upload.
    await flyTo(page, { ...TOKYO, zoom: 7 });
    const uploadsAway = (await stats(page)).uploads;
    await flyTo(page, { ...TOKYO, zoom: 9 });
    expect((await stats(page)).uploads).toBe(uploadsAway);
  });
}
