import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { openGlobe, waitForIdle, type ScenarioReport } from './support/globe.ts';
import { fixtureSession, requestLog } from './support/imagery.ts';

/**
 * Terrain streaming cost, elevation queries and the camera above terrain end to end (M4 increment 3): workers and
 * budgets (F134), synchronous queries at scale (F144) and terrain collision (F146, F147), over the fixture tile
 * server's analytic terrain (a 4,000 m peak at 6.86° E, 45.83° N).
 */

test.describe.configure({ timeout: 240_000 });
test.use({ viewport: { width: 480, height: 360 } });

const BACKENDS = ['webgpu', 'webgl2'] as const;
/** The playground's engine clock at 60 Hz: morphs advance one frame per drawn frame. */
const CLOCK = 'clockStepMs=16.666666666666668';
/** Main-thread time terrain may take per frame, p95 (docs/plan/quality.md, F134). */
const TERRAIN_CPU_BUDGET_MS = 2;
/** Time 10,000 synchronous elevation queries may take, p95 (docs/plan/quality.md, F144). */
const QUERY_BUDGET_MS = 4;
/** The playground's default clearance, meters (`terrainClearanceMeters`). */
const CLEARANCE_METERS = 10;

/** Waits until no terrain tile is queued, loading, decoding or waiting for its upload, and the engine is idle. */
async function waitForTerrain(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const stats = window.vibeglobePlayground?.globe.terrainStats();
          return stats ? stats.queued + stats.loading + stats.decoding + stats.uploadsPending : -1;
        }),
      { timeout: 90_000 },
    )
    .toBe(0);
  await waitForIdle(page);
}

/** A value at a quantile of a list. */
function quantile(values: readonly number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

test('terrain decodes on worker threads, and its main-thread time and uploads per frame stay within budget while zooming in (F134)', async ({
  page,
  browser,
}, testInfo) => {
  const session = await fixtureSession(page);
  await openGlobe(page, `scenario=terrain-alps&session=${session}&zoom=10&tilt=45`);
  await waitForTerrain(page);
  const tracePath = testInfo.outputPath('trace.json');
  await browser.startTracing(page, {
    path: tracePath,
    categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', '__metadata'],
  });
  // Every frame's terrain counters, read right after the frame.
  await page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) throw new Error('no globe');
    const samples: number[][] = [];
    (window as unknown as { terrainSamples: number[][] }).terrainSamples = samples;
    globe.on('frame', () => {
      const stats = globe.terrainStats();
      if (stats) samples.push([stats.msLastFrame, stats.uploadBytesLastFrame, stats.uploadBudgetBytes]);
    });
  });
  for (const zoom of [11, 12, 13, 14]) {
    await page.evaluate((z) => window.vibeglobePlayground?.globe.jumpTo({ zoom: z }), zoom);
    await waitForTerrain(page);
  }
  await browser.stopTracing();
  const samples = await page.evaluate(() => (window as unknown as { terrainSamples: number[][] }).terrainSamples);
  const times = samples.map(([ms = 0]) => ms);
  console.log(
    `terrain per frame: ${samples.length} frames, p50 ${quantile(times, 0.5).toFixed(3)} ms, p95 ${quantile(times, 0.95).toFixed(3)} ms, max ${Math.max(...times).toFixed(3)} ms; uploads max ${Math.max(...samples.map(([, bytes = 0]) => bytes))} bytes`,
  );
  expect(samples.length).toBeGreaterThan(20);
  expect(quantile(times, 0.95)).toBeLessThanOrEqual(TERRAIN_CPU_BUDGET_MS);
  for (const [, bytes = 0, budget = 0] of samples) expect(bytes).toBeLessThanOrEqual(budget);

  // Every terrain tile that arrived was decoded off the main thread, by the engine's worker; nothing decodes on the
  // main thread.
  const tiles = (await requestLog(page, session)).filter(
    (r) => r.source === 'terrain' && r.status === 200 && !r.aborted && r.startMs > 0,
  ).length;
  const trace = JSON.parse(readFileSync(tracePath, 'utf8')) as {
    traceEvents: { name: string; pid: number; tid: number; dur?: number; args?: { name?: string } }[];
  };
  const threads = new Map<string, string>();
  for (const event of trace.traceEvents)
    if (event.name === 'thread_name') threads.set(`${event.pid}:${event.tid}`, event.args?.name ?? '');
  const thread = (event: { pid: number; tid: number }): string => threads.get(`${event.pid}:${event.tid}`) ?? '';
  const decodes = trace.traceEvents.filter((event) => event.name === 'Decode Image');
  expect(tiles).toBeGreaterThan(0);
  expect(decodes.filter((event) => thread(event) === 'CrRendererMain').map((event) => event.dur)).toEqual([]);
  const workerCalls = trace.traceEvents.filter(
    (event) => event.name === 'FunctionCall' && thread(event).startsWith('DedicatedWorker'),
  );
  expect(workerCalls.length).toBeGreaterThanOrEqual(1);
});

test('10,000 synchronous elevation queries at random positions fit in a frame (F144)', async ({ page }) => {
  const session = await fixtureSession(page);
  await openGlobe(page, `scenario=terrain-alps&session=${session}`);
  await waitForTerrain(page);
  const times = await page.evaluate(async () => {
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) throw new Error('no globe');
    const out = { heightMeters: 0, level: 0, noData: true };
    const position = { longitudeDeg: 0, latitudeDeg: 0 };
    let seed = 1;
    const next = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const elapsed: number[] = [];
    let found = 0;
    for (let frame = 0; frame < 40; frame++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const start = performance.now();
      for (let i = 0; i < 10_000; i++) {
        // Half in the view's area, half anywhere.
        const near = (i & 1) === 0;
        position.longitudeDeg = near ? 6.4 + next() : next() * 360 - 180;
        position.latitudeDeg = near ? 45.3 + next() : next() * 170 - 85;
        if (!globe.elevationAt(position, out).noData) found++;
      }
      elapsed.push(performance.now() - start);
    }
    if (found === 0) throw new Error('no query found terrain');
    return elapsed;
  });
  const warm = times.slice(5);
  console.log(`10,000 queries: p50 ${quantile(warm, 0.5).toFixed(3)} ms, p95 ${quantile(warm, 0.95).toFixed(3)} ms`);
  expect(quantile(warm, 0.95)).toBeLessThanOrEqual(QUERY_BUDGET_MS);
});

/** Starts recording, after every frame, the eye's height above the displayed surface and above the finest terrain. */
async function recordClearance(page: Page): Promise<void> {
  await page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) throw new Error('no globe');
    const record = {
      frames: 0,
      minAboveDisplayed: Infinity,
      minAboveFinest: Infinity,
      altitudes: [] as number[],
      grounds: [] as number[],
    };
    (window as unknown as { clearance: typeof record }).clearance = record;
    globe.on('frame', () => {
      const camera = globe.camera;
      const finest = globe.elevationAt({ longitudeDeg: camera.eyeLongitudeDeg, latitudeDeg: camera.eyeLatitudeDeg });
      record.frames++;
      record.minAboveDisplayed = Math.min(record.minAboveDisplayed, camera.altitudeMeters - camera.groundHeightMeters);
      record.minAboveFinest = Math.min(record.minAboveFinest, camera.altitudeMeters - finest.heightMeters);
      record.altitudes.push(camera.altitudeMeters);
      record.grounds.push(camera.groundHeightMeters);
    });
  });
}

interface ClearanceRecord {
  frames: number;
  minAboveDisplayed: number;
  minAboveFinest: number;
  altitudes: number[];
  grounds: number[];
}

async function clearance(page: Page): Promise<ClearanceRecord> {
  return page.evaluate(() => (window as unknown as { clearance: ClearanceRecord }).clearance);
}

for (const backend of BACKENDS) {
  test(`the camera stays the clearance above the terrain through 60 s of zooming, dragging, tilting and turning toward a cliff on ${backend} (F146)`, async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const session = await fixtureSession(page);
    // The valley east of the peak, looking west at its flank.
    await openGlobe(
      page,
      `backend=${backend}&session=${session}&${CLOCK}&scenario=terrain-alps&lon=6.98&lat=45.82&zoom=16&tilt=70&heading=270`,
    );
    await waitForTerrain(page);
    await recordClearance(page);
    const canvas = page.locator('#globe');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('no canvas');
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const holes: number[] = [];
    const end = Date.now() + 60_000;
    for (let step = 0; Date.now() < end; step++) {
      switch (step % 4) {
        case 0:
          // Wheel zoom toward the flank.
          await page.mouse.move(center.x, center.y - 60);
          for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -240);
          break;
        case 1:
          // Drag the ground toward the camera: the eye moves toward the cliff.
          await page.mouse.move(center.x, center.y - 120);
          await page.mouse.down();
          for (let i = 1; i <= 8; i++) await page.mouse.move(center.x, center.y - 120 + i * 20);
          await page.mouse.up();
          break;
        case 2:
          await page.evaluate((s) => {
            const globe = window.vibeglobePlayground?.globe;
            if (globe) globe.jumpTo({ tiltDeg: 60 + ((s * 7) % 25), headingDeg: 250 + ((s * 13) % 40) });
          }, step);
          break;
        default: {
          await waitForIdle(page);
          const frame = (await page.evaluate(() => window.vibeglobePlayground?.checkFrame())) as ScenarioReport;
          holes.push(frame.holes);
        }
      }
    }
    await waitForIdle(page);
    const record = await clearance(page);
    console.log(
      `collision ${backend}: ${record.frames} frames, min above displayed ${record.minAboveDisplayed.toFixed(3)} m, above finest ${record.minAboveFinest.toFixed(3)} m, holes ${JSON.stringify(holes)}`,
    );
    expect(record.frames).toBeGreaterThan(50);
    // The displayed surface is the finest terrain the frame shows; the eye never passes inside the finest loaded tile.
    expect(record.minAboveDisplayed).toBeGreaterThanOrEqual(CLEARANCE_METERS - 0.01);
    expect(record.minAboveFinest).toBeGreaterThanOrEqual(0);
    // No frame looks into the terrain from inside: no background through its back faces.
    expect(holes.every((count) => count === 0)).toBe(true);
  });

  test(`the camera rises smoothly when higher fine terrain arrives under it on ${backend} (F147)`, async ({ page }) => {
    // Fine terrain arrives 4 s late; near the summit the coarse grids lie below it.
    const session = await fixtureSession(page, [{ source: 'terrain', minLevel: 11, latencyMs: 4000 }]);
    await openGlobe(
      page,
      `backend=${backend}&session=${session}&${CLOCK}&scenario=terrain-alps&lon=6.8605&lat=45.8302&zoom=22&tilt=60`,
    );
    await recordClearance(page);
    await waitForTerrain(page);
    const record = await clearance(page);
    const steps = record.altitudes.slice(1).map((altitude, i) => altitude - (record.altitudes[i] ?? altitude));
    const rising = steps.filter((step) => step > 0.01);
    const lift = rising.reduce((sum, step) => sum + step, 0);
    console.log(
      `lift ${backend}: ${record.frames} frames, ${lift.toFixed(2)} m over ${rising.length} frames, largest step ${Math.max(0, ...steps).toFixed(3)} m, min above displayed ${record.minAboveDisplayed.toFixed(3)} m`,
    );
    // The eye never sits below the displayed surface, and keeps its clearance above it.
    expect(record.minAboveDisplayed).toBeGreaterThanOrEqual(CLEARANCE_METERS - 0.01);
    // The fine terrain lifted the eye, over several frames, no step larger than a third of the lift.
    expect(lift).toBeGreaterThan(1);
    expect(rising.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...rising)).toBeLessThanOrEqual(lift / 3);
  });
}
