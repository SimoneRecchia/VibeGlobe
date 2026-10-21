import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { openGlobe } from './support/globe.ts';

interface SamplingNode {
  id: number;
  callFrame: { url: string; functionName: string; lineNumber: number };
  selfSize: number;
  children: SamplingNode[];
}

interface SamplingProfile {
  head: SamplingNode;
  samples: { size: number; nodeId: number }[];
}

const SAMPLING_INTERVAL_BYTES = 64;
/**
 * The engine's frame callback, which the browser calls. V8 sometimes counts objects allocated deep inside three.js
 * against it (strings and buffers of 72 bytes to several kilobytes in the measurements, never a boxed number), so its
 * samples above this size count as the library's. Its own code allocates nothing: it is the core's `onFrame`, which runs
 * the frame function, measured exactly in Node by `packages/core/src/globe/frame-allocation.test.ts`.
 */
const FRAME_CALLBACK = /\/packages\/core\/src\/globe\/create-globe\.ts(\?t=\d+)?:onFrame:/;
const FRAME_CALLBACK_MAX_OWN_BYTES = 32;

interface TraceEvent {
  name: string;
  dur?: number;
}

/**
 * Engine source files: core, renderer and controls (served from their TypeScript sources by the playground), except the
 * createView shim counted with the library below.
 */
const ENGINE_SOURCE = /\/packages\/(core|controls)\/src\/|\/packages\/renderer\/src\/(?!webgpu-compat\.ts:)/;
/**
 * The rendering library's bundle, and the engine's shim around `GPUTexture.createView` (`webgpu-compat.ts`): three.js
 * creates a view of the canvas texture every frame through it, and V8 counts the native view object against the
 * innermost JavaScript function, which is the shim whenever it is not inlined into three.js. The shim itself allocates
 * nothing (`webgpu-compat.test.ts`).
 */
const LIBRARY_SOURCE = /\/three\.webgpu[^/]*\.js|\/packages\/renderer\/src\/webgpu-compat\.ts:/;
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

/**
 * Sums sampled allocation bytes per allocation site, each sample scaled as V8 scales them (a sample stands for
 * size / (1 − e^(−size / interval)) bytes). Large samples counted against the frame callback go to a library site.
 */
function allocationSites(profile: SamplingProfile): Map<string, number> {
  const sites = new Map<number, string>();
  const visit = (node: SamplingNode): void => {
    sites.set(node.id, `${node.callFrame.url}:${node.callFrame.functionName}:${node.callFrame.lineNumber}`);
    for (const child of node.children) visit(child);
  };
  visit(profile.head);
  const out = new Map<string, number>();
  for (const sample of profile.samples) {
    let site = sites.get(sample.nodeId) ?? '(unknown)';
    if (FRAME_CALLBACK.test(site) && sample.size > FRAME_CALLBACK_MAX_OWN_BYTES)
      site = '/three.webgpu.js (counted against the frame callback)';
    const bytes = sample.size / (1 - Math.exp(-sample.size / SAMPLING_INTERVAL_BYTES));
    out.set(site, (out.get(site) ?? 0) + bytes);
  }
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
    samplingInterval: SAMPLING_INTERVAL_BYTES,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  await page.waitForTimeout(durationMs);
  const { profile } = (await session.send('HeapProfiler.stopSampling')) as { profile: SamplingProfile };
  await session.send('HeapProfiler.disable');
  return {
    frames: (await frameNumber(page)) - first,
    sites: allocationSites(profile),
    frameCallbackSeen: containsFunction(profile.head, FRAME_CALLBACK),
  };
}

/** True when a function whose site matches `site` is on the profile's call tree. */
function containsFunction(node: SamplingNode, site: RegExp): boolean {
  const { url, functionName, lineNumber } = node.callFrame;
  return (
    site.test(`${url}:${functionName}:${lineNumber}`) || node.children.some((child) => containsFunction(child, site))
  );
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
  // The rule above follows the callback's name: a renamed callback must fail here, not count the library as the engine.
  expect(allocations.frameCallbackSeen, 'FRAME_CALLBACK must name the engine frame callback').toBe(true);
  expect(gc.frames).toBeGreaterThan(600);
  // The engine's own code, beyond the timestamp every frame callback receives: less than one boxed number per frame on
  // average means no frame allocates.
  expect(report.engineBytesPerFrame - report.controlBytesPerFrame, JSON.stringify(report)).toBeLessThan(12);
  expect(report.libraryBytesPerFrame).toBeLessThan(LIBRARY_BYTES_PER_FRAME);
  expect(longest, JSON.stringify(report)).toBeLessThan(MAX_GC_PAUSE_MS);
});
