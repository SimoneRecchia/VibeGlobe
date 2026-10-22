import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { canvasImage, openGlobe, waitForIdle, type ScenarioReport } from './support/globe.ts';
import { hardwareGpu } from '../scripts/browser/gpu-args.ts';
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
async function waitForTerrain(page: Page, timeoutMs = 90_000): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const stats = window.vibeglobePlayground?.globe.terrainStats();
          return stats ? stats.queued + stats.loading + stats.decoding + stats.uploadsPending : -1;
        }),
      { timeout: timeoutMs },
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
  // Terrain only, on a small canvas: imagery streaming is not what this measures and only slows the zoom steps.
  await page.setViewportSize({ width: 320, height: 240 });
  const session = await fixtureSession(page);
  await openGlobe(page, `scenario=terrain-alps&session=${session}&zoom=10&tilt=45&imagery=none`);
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
  // The time is gated on a real GPU only (ADR 0012), like F144's; the upload bytes everywhere.
  if (hardwareGpu()) expect(quantile(times, 0.95)).toBeLessThanOrEqual(TERRAIN_CPU_BUDGET_MS);
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

test('10,000 synchronous elevation queries at random positions fit in a frame (F144)', async ({ page }, testInfo) => {
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
    // The positions are drawn before the clock starts: the budget is the queries' time, not the generator's.
    const lons = new Float64Array(10_000);
    const lats = new Float64Array(10_000);
    for (let frame = 0; frame < 40; frame++) {
      for (let i = 0; i < 10_000; i++) {
        // Half in the view's area, half anywhere.
        const near = (i & 1) === 0;
        lons[i] = near ? 6.4 + next() : next() * 360 - 180;
        lats[i] = near ? 45.3 + next() : next() * 170 - 85;
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const start = performance.now();
      for (let i = 0; i < 10_000; i++) {
        position.longitudeDeg = lons[i] ?? 0;
        position.latitudeDeg = lats[i] ?? 0;
        if (!globe.elevationAt(position, out).noData) found++;
      }
      elapsed.push(performance.now() - start);
    }
    if (found === 0) throw new Error('no query found terrain');
    return elapsed;
  });
  const warm = times.slice(5);
  console.log(
    `10,000 queries: p50 ${quantile(warm, 0.5).toFixed(3)} ms, p95 ${quantile(warm, 0.95).toFixed(3)} ms; sorted ${JSON.stringify([...warm].sort((a, b) => a - b))}`,
  );
  // Timings are gated on a real GPU only (ADR 0012, docs/plan/quality.md): on the software GPU its rendering threads
  // share the CPU with the page, and the time is recorded (`npm run hardware-run` gates it).
  testInfo.annotations.push({ type: 'p95 ms per 10,000 queries', description: quantile(warm, 0.95).toFixed(3) });
  if (hardwareGpu()) expect(quantile(warm, 0.95)).toBeLessThanOrEqual(QUERY_BUDGET_MS);
});

/** Starts recording, after every frame, the eye's height above the displayed surface and above the finest terrain. */
/** In the page: records, after every frame, the eye's height above the displayed surface and above the finest terrain. */
function installClearanceRecorder(): void {
  const globe = window.vibeglobePlayground?.globe;
  if (!globe) throw new Error('no globe');
  const record = {
    frames: 0,
    minAboveDisplayed: Infinity,
    minAboveFinest: Infinity,
    altitudes: [] as number[],
    grounds: [] as number[],
    levels: [] as number[],
    worst: [] as number[],
  };
  (window as unknown as { clearance: typeof record }).clearance = record;
  globe.on('frame', () => {
    const camera = globe.camera;
    const finest = globe.elevationAt({ longitudeDeg: camera.eyeLongitudeDeg, latitudeDeg: camera.eyeLatitudeDeg });
    record.frames++;
    record.minAboveDisplayed = Math.min(record.minAboveDisplayed, camera.altitudeMeters - camera.groundHeightMeters);
    if (camera.altitudeMeters - finest.heightMeters < record.minAboveFinest) {
      // The worst frame, for the log.
      record.worst = [camera.eyeLongitudeDeg, camera.eyeLatitudeDeg, camera.altitudeMeters, camera.groundHeightMeters]
        .concat([finest.heightMeters, finest.level, camera.tiltDeg, record.frames])
        .map((value) => +value.toFixed(5));
    }
    record.minAboveFinest = Math.min(record.minAboveFinest, camera.altitudeMeters - finest.heightMeters);
    record.altitudes.push(camera.altitudeMeters);
    record.grounds.push(camera.groundHeightMeters);
    record.levels.push(finest.level);
  });
}

/** Starts the clearance recording on the page's globe. */
async function recordClearance(page: Page): Promise<void> {
  await page.evaluate(installClearanceRecorder);
}

/** Starts the clearance recording with the page itself, from the globe's first frame: before a slow start can hide it. */
async function recordClearanceFromStart(page: Page): Promise<void> {
  await page.addInitScript(`(() => {
    const install = ${installClearanceRecorder.toString()};
    const wait = () => (window.vibeglobePlayground?.globe ? install() : setTimeout(wait, 5));
    wait();
  })()`);
}

interface ClearanceRecord {
  frames: number;
  minAboveDisplayed: number;
  minAboveFinest: number;
  altitudes: number[];
  grounds: number[];
  /** The level of the finest resident terrain under the eye, each frame. */
  levels: number[];
  /** The frame furthest below the finest terrain: eye lon, lat, altitude, displayed ground, finest, level, tilt, frame. */
  worst: number[];
}

async function clearance(page: Page): Promise<ClearanceRecord> {
  return page.evaluate(() => (window as unknown as { clearance: ClearanceRecord }).clearance);
}

for (const backend of BACKENDS) {
  test(`the camera stays the clearance above the terrain through 60 s of zooming, dragging, tilting and turning toward a cliff on ${backend} (F146)`, async ({
    page,
  }, testInfo) => {
    // 60 s of input plus the initial streaming on a 320 × 240 canvas.
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 320, height: 240 });
    const session = await fixtureSession(page);
    // The valley east of the peak, looking west at its flank; the base image only, so the terrain streams faster.
    await openGlobe(
      page,
      `backend=${backend}&session=${session}&${CLOCK}&scenario=terrain-alps&imagery=&lon=6.98&lat=45.82&zoom=16&tilt=70&heading=270`,
    );
    await waitForTerrain(page);
    await recordClearance(page);
    const canvas = page.locator('#globe');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('no canvas');
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const unit = box.height / 18;
    const holes: number[] = [];
    const end = Date.now() + 60_000;
    for (let step = 0; Date.now() < end; step++) {
      switch (step % 4) {
        case 0:
          // Wheel zoom toward the flank.
          await page.mouse.move(center.x, center.y - 3 * unit);
          for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -240);
          break;
        case 1:
          // Drag the ground toward the camera: the eye moves toward the cliff.
          // The ground grabbed below the center, near the camera: each drag moves the eye tens of meters, not the
          // thousands of kilometers a grab near the horizon would.
          await page.mouse.move(center.x, center.y + 2 * unit);
          await page.mouse.down();
          for (let i = 1; i <= 8; i++) await page.mouse.move(center.x, center.y + 2 * unit + (i * unit) / 2);
          await page.mouse.up();
          break;
        case 2:
          await page.evaluate((s) => {
            const globe = window.vibeglobePlayground?.globe;
            if (globe) globe.jumpTo({ tiltDeg: 60 + ((s * 7) % 25), headingDeg: 250 + ((s * 13) % 40) });
          }, step);
          break;
        default: {
          // A frame drawn now, while tiles still stream: no frame may show the inside of the terrain.
          const frame = (await page.evaluate(() => window.vibeglobePlayground?.checkFrame())) as ScenarioReport;
          holes.push(frame.holes);
          // A frame with holes is saved once, to investigate offline.
          if (frame.holes > 0 && holes.filter((count) => count > 0).length === 1) {
            const image = await canvasImage(page);
            const camera = await page.evaluate(() => window.vibeglobePlayground?.globe.camera);
            writeFileSync(testInfo.outputPath('frame-with-holes.png'), PNG.sync.write(image));
            writeFileSync(testInfo.outputPath('camera.json'), JSON.stringify(camera));
          }
        }
      }
    }
    const record = await clearance(page);
    console.log(
      `collision ${backend}: ${record.frames} frames, min above displayed ${record.minAboveDisplayed.toFixed(3)} m, above finest ${record.minAboveFinest.toFixed(3)} m (worst frame ${JSON.stringify(record.worst)}), holes ${JSON.stringify(holes)}`,
    );
    expect(record.frames).toBeGreaterThan(50);
    // The displayed surface is the finest terrain the frame shows; the eye never passes inside the finest loaded tile.
    expect(record.minAboveDisplayed).toBeGreaterThanOrEqual(CLEARANCE_METERS - 0.01);
    expect(record.minAboveFinest).toBeGreaterThanOrEqual(0);
    // No frame looks into the terrain from inside: no background through its back faces.
    expect(holes.every((count) => count === 0)).toBe(true);
  });

  test(`the camera rises smoothly when higher fine terrain arrives under it on ${backend} (F147)`, async ({ page }) => {
    // Terrain from level 9 arrives 9 s late (under the 10 s first-byte timeout); near the summit the coarser grids shown
    // until then lie meters below it. The recording starts with the page, from the first frame.
    // A small canvas keeps software-rendered frames short.
    await page.setViewportSize({ width: 320, height: 240 });
    const session = await fixtureSession(page, [{ source: 'terrain', minLevel: 9, latencyMs: 9000 }]);
    await recordClearanceFromStart(page);
    await openGlobe(
      page,
      `backend=${backend}&session=${session}&${CLOCK}&scenario=terrain-alps&lon=6.8605&lat=45.8302&zoom=22&tilt=60`,
    );
    // The delayed tiles come a few at a time per host, 9 s each: over a minute in all.
    await waitForTerrain(page, 180_000);
    const record = await clearance(page);
    // From the frame before the first delayed tile: the jump onto the first terrain (the eye starts on the ellipsoid,
    // inside the mountain) is the floor of F146, not the arrival of finer terrain.
    const first = record.levels.findIndex((level) => level >= 9);
    expect(first).toBeGreaterThan(0);
    const altitudes = record.altitudes.slice(first - 1);
    const steps = altitudes.slice(1).map((altitude, i) => altitude - (altitudes[i] ?? altitude));
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
