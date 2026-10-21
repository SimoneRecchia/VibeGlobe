import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { openGlobe } from './support/globe.ts';

// ADR 0010's leak suite: 100 mount/unmount cycles, as a single-page app does on navigation, must leave the JS heap, the
// DOM, the event listeners and the live GPU objects where they were. Chromium only (CDP heap and DOM counters).

const CYCLES = 100;
const WARM_UP_CYCLES = 10;
/**
 * Growth allowed over 100 cycles of the JS objects in the heap, V8's compiled code and native records excluded. One
 * engine instance holds about 2 MB of them, so a leak of a fraction of one per cycle exceeds this by far.
 */
const HEAP_NOISE_BYTES = 64 * 1024;
/**
 * Node types of a heap snapshot that are not the page's objects: code the JIT keeps compiling as functions warm up
 * (tiering continues long after the warm-up cycles) and native records such as the browser's performance timeline.
 */
const NOT_OBJECTS = new Set(['code', 'hidden', 'native', 'synthetic', 'object shape']);

/**
 * Counts live GPU objects: WebGL2 objects created and not deleted in contexts not lost, and WebGPU devices not
 * destroyed with their buffers and textures not destroyed (a lost context or destroyed device frees its objects).
 */
function trackGpuObjects(): void {
  // Weak references only: the tracker must not keep a context, its canvas or a device alive.
  const counts = new WeakMap<object, number>();
  const owners: WeakRef<object>[] = [];
  const change = (owner: object, delta: number): void => {
    if (!counts.has(owner)) owners.push(new WeakRef(owner));
    counts.set(owner, (counts.get(owner) ?? 0) + delta);
  };
  const gl = WebGL2RenderingContext.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const kind of ['Buffer', 'Texture', 'Framebuffer', 'Renderbuffer', 'VertexArray', 'Program', 'Shader']) {
    const create = gl[`create${kind}`];
    const remove = gl[`delete${kind}`];
    if (!create || !remove) continue;
    gl[`create${kind}`] = function (this: WebGL2RenderingContext, ...args: unknown[]) {
      const object = create.apply(this, args);
      if (object) change(this, 1);
      return object;
    };
    gl[`delete${kind}`] = function (this: WebGL2RenderingContext, ...args: unknown[]) {
      if (args[0]) change(this, -1);
      return remove.apply(this, args);
    };
  }
  const lostDevices = new WeakSet<GPUDevice>();
  const devices: WeakRef<GPUDevice>[] = [];
  const gpu = globalThis.GPUAdapter?.prototype;
  if (gpu) {
    const requestDevice = gpu.requestDevice;
    gpu.requestDevice = async function (this: GPUAdapter, ...args: Parameters<GPUAdapter['requestDevice']>) {
      const device = await requestDevice.apply(this, args);
      devices.push(new WeakRef(device));
      void device.lost.then(() => lostDevices.add(device));
      return device;
    };
    const device = GPUDevice.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const create of ['createBuffer', 'createTexture']) {
      const original = device[create];
      if (!original) continue;
      device[create] = function (this: GPUDevice, ...args: unknown[]) {
        const object = original.apply(this, args) as GPUBuffer | GPUTexture;
        change(this, 1);
        const destroy = object.destroy.bind(object);
        let destroyed = false;
        object.destroy = () => {
          if (!destroyed) change(this, -1);
          destroyed = true;
          destroy();
        };
        return object;
      };
    }
  }
  // Drops the references to collected objects, so the tracker's own WeakRefs do not grow with the cycles.
  const prune = (refs: WeakRef<object>[]): void => {
    let kept = 0;
    for (const ref of refs) if (ref.deref()) refs[kept++] = ref;
    refs.length = kept;
  };
  (window as unknown as { liveGpuObjects: () => number }).liveGpuObjects = () => {
    prune(owners);
    prune(devices);
    let count = 0;
    for (const ref of owners) {
      const owner = ref.deref();
      if (!owner) continue;
      const lostContext = owner instanceof WebGL2RenderingContext && owner.isContextLost();
      const lostDevice = typeof GPUDevice !== 'undefined' && owner instanceof GPUDevice && lostDevices.has(owner);
      if (!lostContext && !lostDevice) count += counts.get(owner) ?? 0;
    }
    return count;
  };
  (window as unknown as { liveContexts: () => number }).liveContexts = () => {
    let count = 0;
    for (const ref of devices) {
      const device = ref.deref();
      if (device && !lostDevices.has(device)) count++;
    }
    for (const ref of owners) {
      const owner = ref.deref();
      if (owner instanceof WebGL2RenderingContext && !owner.isContextLost()) count++;
    }
    return count;
  };
}

async function cycle(page: Page, count: number): Promise<void> {
  await page.evaluate(async (cycles) => {
    const hooks = window.vibeglobePlayground;
    if (!hooks) throw new Error('no playground');
    for (let i = 0; i < cycles; i++) {
      const mounted = hooks.mount();
      await mounted.globe.ready;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      mounted.unmount();
    }
  }, count);
}

interface Snapshot {
  /** Self size of the heap's JS objects, arrays, strings and closures. */
  heapBytes: number;
  /** Instances per constructor name. */
  instances: Map<string, number>;
  nodes: number;
  listeners: number;
  gpuObjects: number;
  contexts: number;
}

async function snapshot(page: Page, cdp: CDPSession): Promise<Snapshot> {
  // Releases finish asynchronously (device loss promises, context loss): let them settle before counting.
  await page.waitForTimeout(500);
  // Collect first, so counting the GPU objects prunes the tracker's references to collected ones.
  await cdp.send('HeapProfiler.collectGarbage');
  const gpu = await page.evaluate(() => {
    const w = window as unknown as { liveGpuObjects: () => number; liveContexts: () => number };
    return { gpuObjects: w.liveGpuObjects(), contexts: w.liveContexts() };
  });
  const heap = await heapObjects(cdp);
  const { nodes, jsEventListeners } = (await cdp.send('Memory.getDOMCounters')) as {
    nodes: number;
    jsEventListeners: number;
  };
  return { ...heap, nodes, listeners: jsEventListeners, ...gpu };
}

/** Takes a heap snapshot (after a full collection) and sums its JS objects. */
async function heapObjects(cdp: CDPSession): Promise<{ heapBytes: number; instances: Map<string, number> }> {
  const chunks: string[] = [];
  const collect = ({ chunk }: { chunk: string }): void => {
    chunks.push(chunk);
  };
  cdp.on('HeapProfiler.addHeapSnapshotChunk', collect);
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  cdp.off('HeapProfiler.addHeapSnapshotChunk', collect);
  const heap = JSON.parse(chunks.join('')) as {
    snapshot: { meta: { node_fields: string[]; node_types: [string[]] } };
    nodes: number[];
    strings: string[];
  };
  const fields = heap.snapshot.meta.node_fields;
  const [typeNames] = heap.snapshot.meta.node_types;
  const [typeField, nameField, sizeField] = ['type', 'name', 'self_size'].map((field) => fields.indexOf(field));
  let heapBytes = 0;
  const instances = new Map<string, number>();
  for (let node = 0; node < heap.nodes.length; node += fields.length) {
    const type = typeNames[heap.nodes[node + (typeField ?? 0)] ?? 0] ?? '';
    if (NOT_OBJECTS.has(type)) continue;
    heapBytes += heap.nodes[node + (sizeField ?? 0)] ?? 0;
    if (type !== 'object') continue;
    const name = heap.strings[heap.nodes[node + (nameField ?? 0)] ?? 0] ?? '';
    instances.set(name, (instances.get(name) ?? 0) + 1);
  }
  return { heapBytes, instances };
}

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`${CYCLES} mount/unmount cycles leave heap, DOM, listeners and GPU objects flat on ${backend} (ADR 0010 leak suite)`, async ({
    page,
  }) => {
    test.setTimeout(600_000);
    await page.addInitScript(trackGpuObjects);
    await openGlobe(page, `backend=${backend}&zoom=3`);
    const cdp = await page.context().newCDPSession(page);
    // Warm-up: compiled code, shader caches and lazily created singletons are not leaks.
    await cycle(page, WARM_UP_CYCLES);
    const before = await snapshot(page, cdp);
    await cycle(page, CYCLES);
    const after = await snapshot(page, cdp);
    // Constructors with more instances than before: a leak of one object per cycle shows as a growth of CYCLES.
    const grown = [...after.instances]
      .map(([name, count]) => [name, count - (before.instances.get(name) ?? 0)] as const)
      .filter(([, growth]) => growth > 0)
      .sort((a, b) => b[1] - a[1]);
    const show = (snap: Snapshot): string => JSON.stringify({ ...snap, instances: undefined });
    console.log(
      `leak suite ${backend}: before ${show(before)} after ${show(after)} grown ${JSON.stringify(grown.slice(0, 5))}`,
    );
    expect(grown.filter(([, growth]) => growth >= CYCLES / 2)).toEqual([]);
    expect(after.contexts).toBe(before.contexts);
    expect(after.gpuObjects).toBe(before.gpuObjects);
    expect(after.nodes).toBeLessThanOrEqual(before.nodes);
    expect(after.listeners).toBeLessThanOrEqual(before.listeners);
    expect(after.heapBytes - before.heapBytes).toBeLessThan(HEAP_NOISE_BYTES);
  });
}
