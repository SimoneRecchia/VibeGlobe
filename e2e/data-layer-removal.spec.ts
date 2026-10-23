// Removing data layers frees what they held (M10, F385): a layer of every primitive type (points, clustered points,
// markers, labels, lines, polygons with extrusions, circles, glTF models) is added and removed 100 times; after each
// cycle the GPU meshes and bytes are back to their baseline, the JavaScript heap stays within a tolerance of it after
// garbage collection, and no handlers, workers, intervals or timers remain from the removed layers.
import { expect, test, type Page } from '@playwright/test';
import { nextFrame, openGlobe, waitForIdle } from './support/globe.ts';

test.use({ viewport: { width: 320, height: 240 } });

const BACKENDS = ['webgpu', 'webgl2'] as const;
const CYCLES = 100;
/** Heap growth allowed over the warm baseline after collection: allocator noise, far below one cycle's layers. */
const HEAP_TOLERANCE_BYTES = 2 * 1024 * 1024;

declare global {
  interface Window {
    /** Live timers, intervals and workers, counted by the init script below. */
    vibeglobeLive?: { timeouts: Set<number>; intervals: Set<number>; workers: number };
    /** One add-and-remove cycle of every layer type; returns the removed layers' remaining handlers. */
    vibeglobeCycle?: (drawn: () => Promise<void>) => Promise<number>;
  }
}

/** Wraps the timer and worker constructors to count what is alive. */
function countLive(): void {
  const live = { timeouts: new Set<number>(), intervals: new Set<number>(), workers: 0 };
  window.vibeglobeLive = live;
  const { setTimeout: st, clearTimeout: ct, setInterval: si, clearInterval: ci } = window;
  window.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
    const id: number = st(
      (...a: unknown[]) => {
        live.timeouts.delete(id);
        if (typeof handler === 'function') (handler as (...b: unknown[]) => void)(...a);
      },
      ms,
      ...args,
    );
    live.timeouts.add(id);
    return id;
  }) as typeof window.setTimeout;
  window.clearTimeout = ((id?: number) => {
    if (id !== undefined) live.timeouts.delete(id);
    ct(id);
  }) as typeof window.clearTimeout;
  window.setInterval = ((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
    const id = si(handler, ms, ...args);
    live.intervals.add(id);
    return id;
  }) as typeof window.setInterval;
  window.clearInterval = ((id?: number) => {
    if (id !== undefined) live.intervals.delete(id);
    ci(id);
  }) as typeof window.clearInterval;
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      live.workers += 1;
    }
    override terminate(): void {
      live.workers -= 1;
      super.terminate();
    }
  };
}

/** Installs `window.vibeglobeCycle`, which adds one layer of every type to a stack, draws, and removes them. */
async function installCycle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const prefix = '/@id/@vibeglobe/';
    const layers = (await import(/* @vite-ignore */ `${prefix}layers`)) as typeof import('@vibeglobe/layers');
    const { ModelLayer } = (await import(
      /* @vite-ignore */ `${prefix}layers/models`
    )) as typeof import('@vibeglobe/layers/models');
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) throw new Error('no globe');
    const { stack } = layers.createGlobeLayers(globe);
    const point = (lon: number, lat: number) => ({ type: 'Point' as const, coordinates: [lon, lat] });
    const feature = (id: string, geometry: import('@vibeglobe/layers').Geometry, properties = {}) => ({
      type: 'Feature' as const,
      id,
      properties,
      geometry,
    });
    const square = (lon: number, lat: number, d: number) => ({
      type: 'Polygon' as const,
      coordinates: [
        [
          [lon, lat],
          [lon + d, lat],
          [lon + d, lat + d],
          [lon, lat + d],
          [lon, lat],
        ],
      ],
    });
    const grid = Array.from({ length: 400 }, (_, i) => feature(`p${i}`, point(11 + (i % 20) * 0.1, 41 + i * 0.005)));
    window.vibeglobeCycle = async (drawn) => {
      const added = [
        layers.pointLayer({ id: 'points', data: grid }),
        layers.pointLayer({ id: 'clusters', data: grid, cluster: { radiusPx: 40 } }),
        layers.markerLayer({ id: 'markers', data: grid.slice(0, 20) }),
        layers.labelLayer({
          id: 'labels',
          data: grid.slice(0, 20).map((f, i) => ({ ...f, properties: { name: `Label ${i}` } })),
          style: { 'text-field': ['get', 'name'] },
        }),
        layers.polylineLayer({
          id: 'lines',
          data: [
            feature('l', {
              type: 'LineString',
              coordinates: [
                [11, 41],
                [13, 42],
              ],
            }),
          ],
        }),
        layers.polygonLayer({
          id: 'polygons',
          data: [feature('a', square(12, 41.5, 0.3)), feature('b', square(12.5, 41.5, 0.2), { h: 4000 })],
          style: { 'fill-extrusion-height': ['coalesce', ['get', 'h'], 0] },
        }),
        layers.circleLayer({
          id: 'circles',
          data: [feature('c', point(12.4, 41.9), { radiusMeters: 20_000 })],
        }),
        new ModelLayer({
          id: 'models',
          models: [
            {
              id: 'm',
              url: `${location.origin}/models/pyramid.gltf`,
              position: { longitudeDeg: 12.3, latitudeDeg: 41.7 },
              scale: 2000,
            },
          ],
        }),
      ];
      const off: (() => void)[] = [];
      for (const layer of added) {
        stack.add(layer);
        off.push(layer.on('click', () => undefined));
      }
      await (added.at(-1) as InstanceType<typeof ModelLayer>).ready;
      await drawn();
      for (const layer of added) stack.remove(layer);
      await drawn();
      return added.reduce((sum, layer) => sum + (layer as { listenerCount: number }).listenerCount, 0);
    };
  });
}

/** Two frames drawn by the engine. */
async function drawn(page: Page): Promise<void> {
  await nextFrame(page);
  await nextFrame(page);
}

const counts = (page: Page) =>
  page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    const live = window.vibeglobeLive;
    if (!globe || !live) throw new Error('no globe');
    const { meshes, gpuBytes, textures } = globe.resourceCounts();
    return { meshes, gpuBytes, textures, intervals: live.intervals.size, workers: live.workers };
  });

for (const backend of BACKENDS) {
  test(`adding and removing a layer of every primitive type 100 times returns GPU and heap memory to their baseline and leaves no handlers, workers or timers on ${backend} (F385)`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.addInitScript(countLive);
    await openGlobe(page, `backend=${backend}&viewMode=2d&lon=12.2&lat=41.6&zoom=7`);
    await installCycle(page);
    const cdp = await page.context().newCDPSession(page);
    const heap = async (): Promise<number> => {
      await cdp.send('HeapProfiler.collectGarbage');
      return (await cdp.send('Runtime.getHeapUsage')).usedSize;
    };
    const cycle = () =>
      page.evaluate(
        () =>
          window.vibeglobeCycle?.(
            () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
          ) ?? -1,
      );
    // A warm-up cycle compiles the materials and loads the glTF loader, which stay for the next layers.
    expect(await cycle()).toBe(0);
    await waitForIdle(page);
    await drawn(page);
    const baseline = await counts(page);
    const baseHeap = await heap();
    const timeoutsAtBaseline = await page.evaluate(() => window.vibeglobeLive?.timeouts.size ?? 0);
    for (let i = 1; i <= CYCLES; i++) {
      expect(await cycle(), `cycle ${i}: handlers left`).toBe(0);
      expect(await counts(page), `cycle ${i}`).toEqual(baseline);
      if (i % 10 === 0) {
        const used = await heap();
        expect(used - baseHeap, `cycle ${i}: heap growth`).toBeLessThanOrEqual(HEAP_TOLERANCE_BYTES);
      }
    }
    await waitForIdle(page);
    const timeouts = await page.evaluate(() => window.vibeglobeLive?.timeouts.size ?? 0);
    expect(timeouts, 'pending timers').toBeLessThanOrEqual(timeoutsAtBaseline);
  });
}
