import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { openGlobe } from './support/globe.ts';

interface SamplingNode {
  callFrame: { url: string; functionName: string; lineNumber: number };
  selfSize: number;
  children: SamplingNode[];
}

interface TraceEvent {
  name: string;
  dur?: number;
}

/** Engine source files: core, renderer and controls (served from their TypeScript sources by the playground). */
const ENGINE_SOURCE = /\/packages\/(core|renderer|controls)\/src\//;
/** The rendering library's bundle. */
const LIBRARY_SOURCE = /\/three\.webgpu[^/]*\.js/;
/**
 * three.js 0.186 rebuilds cache keys and uniform update ranges on every render, about 6 KB per frame for the M2 scene
 * once its unused lighting system is off (ADR 0018). This budget only stops that from growing; the engine's own code
 * allocates nothing.
 */
const LIBRARY_BYTES_PER_FRAME = 8192;
/** Half a 60 Hz frame: a garbage-collection pause shorter than this cannot make a frame miss its deadline by itself. */
const MAX_GC_PAUSE_MS = 8;
/** Garbage-collection work that runs on the main thread (background marking and sweeping do not). */
const MAIN_THREAD_GC = /^(MinorGC|MajorGC|V8\.GCScavenger|V8\.GCFinalizeMC|V8\.GCIncrementalMarking)$/;

/** Starts continuous drag motion driven from the page with reused objects, so the driver itself allocates nothing. */
async function startDragMotion(page: Page): Promise<void> {
  await page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    const canvas = document.querySelector('#globe');
    if (!globe || !canvas) throw new Error('no globe');
    const center = { xPx: canvas.clientWidth / 2, yPx: canvas.clientHeight / 2 };
    const anchor = globe.navigation.grab(center);
    if (!anchor) throw new Error('center off the globe');
    const point = { xPx: center.xPx, yPx: center.yPx };
    let angle = 0;
    const tick = (): void => {
      angle += 0.05;
      point.xPx = center.xPx + 20 * Math.cos(angle);
      point.yPx = center.yPx + 20 * Math.sin(angle);
      globe.navigation.dragTo(anchor, point);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // Control: an empty requestAnimationFrame callback. The browser boxes each callback's timestamp, and V8 counts it
    // against the callback (the engine's frame function included).
    const control = (): void => {
      requestAnimationFrame(control);
    };
    requestAnimationFrame(control);
  });
}

/** Sums sampled allocation bytes per allocation site. */
function allocationSites(node: SamplingNode, out: Map<string, number>): Map<string, number> {
  if (node.selfSize > 0) {
    const site = `${node.callFrame.url}:${node.callFrame.functionName}:${node.callFrame.lineNumber}`;
    out.set(site, (out.get(site) ?? 0) + node.selfSize);
  }
  for (const child of node.children) allocationSites(child, out);
  return out;
}

/** Sampled bytes allocated per frame by functions whose source matches, with everything they call outside it. */
function bytesPerFrame(sites: Map<string, number>, source: RegExp, frames: number): number {
  return [...sites].filter(([site]) => source.test(site)).reduce((sum, [, bytes]) => sum + bytes, 0) / frames;
}

async function frameNumber(page: Page): Promise<number> {
  return page.evaluate(() => window.vibeglobePlayground?.globe.frameNumber ?? 0);
}

async function sampleAllocations(page: Page, session: CDPSession, durationMs: number) {
  await session.send('HeapProfiler.enable');
  const first = await frameNumber(page);
  await session.send('HeapProfiler.startSampling', {
    samplingInterval: 64,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  await page.waitForTimeout(durationMs);
  const { profile } = (await session.send('HeapProfiler.stopSampling')) as { profile: { head: SamplingNode } };
  await session.send('HeapProfiler.disable');
  return { frames: (await frameNumber(page)) - first, sites: allocationSites(profile.head, new Map()) };
}

async function traceGc(page: Page, session: CDPSession, durationMs: number) {
  const events: TraceEvent[] = [];
  session.on('Tracing.dataCollected', ({ value }) => {
    for (const event of value) events.push({ name: String(event['name']), dur: Number(event['dur'] ?? 0) });
  });
  await session.send('Tracing.start', {
    traceConfig: { includedCategories: ['devtools.timeline', 'v8', 'disabled-by-default-v8.gc'] },
  });
  const first = await frameNumber(page);
  await page.waitForTimeout(durationMs);
  const frames = (await frameNumber(page)) - first;
  const done = new Promise<void>((resolve) => session.once('Tracing.tracingComplete', () => resolve()));
  await session.send('Tracing.end');
  await done;
  return { frames, pauses: events.filter((event) => MAIN_THREAD_GC.test(event.name)) };
}

// A small canvas keeps the software GPU of CI at about 30 frames per second, so the optimizing compiler reaches its
// steady state within the warm-up.
test.use({ viewport: { width: 320, height: 240 } });

test('the frame loop allocates nothing in steady-state motion and no GC pause can drop a frame (F064)', async ({
  page,
}) => {
  test.setTimeout(330_000);
  await openGlobe(page, 'backend=webgpu&lon=10&lat=45&zoom=3');
  await startDragMotion(page);
  // Warm-up: tiles around the motion path are built and cached, and the optimizing compiler settles (functions called
  // once per frame take one to two minutes to reach the optimizing tier at 30 frames per second).
  await page.waitForTimeout(120_000);
  const session = await page.context().newCDPSession(page);

  const allocations = await sampleAllocations(page, session, 30_000);
  // Without the heap sampler, which allocates and collects on its own.
  const gc = await traceGc(page, session, 60_000);

  const engine = [...allocations.sites].filter(([site]) => ENGINE_SOURCE.test(site));
  const longest = gc.pauses.reduce((max, event) => Math.max(max, (event.dur ?? 0) / 1000), 0);
  const report = {
    sampledFrames: allocations.frames,
    engineSites: engine,
    engineBytesPerFrame: bytesPerFrame(allocations.sites, ENGINE_SOURCE, allocations.frames),
    controlBytesPerFrame: bytesPerFrame(allocations.sites, /:control:/, allocations.frames),
    libraryBytesPerFrame: bytesPerFrame(allocations.sites, LIBRARY_SOURCE, allocations.frames),
    tracedFrames: gc.frames,
    gcPauses: gc.pauses.length,
    longestGcPauseMs: longest,
  };
  await test.info().attach('allocations', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  expect(allocations.frames).toBeGreaterThan(300);
  expect(gc.frames).toBeGreaterThan(600);
  // The engine's own code, beyond the timestamp every frame callback receives: less than one boxed number per frame on
  // average means no frame allocates.
  expect(report.engineBytesPerFrame - report.controlBytesPerFrame, JSON.stringify(report)).toBeLessThan(12);
  expect(report.libraryBytesPerFrame).toBeLessThan(LIBRARY_BYTES_PER_FRAME);
  expect(longest, JSON.stringify(report)).toBeLessThan(MAX_GC_PAUSE_MS);
});
