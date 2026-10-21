import { expect, test, type Page } from '@playwright/test';
import type { GeoPosition } from '@vibeglobe/core';
import {
  BACKGROUND_RGB,
  canvasImage,
  pageImage,
  expectCompleteGlobe,
  geoToScreen,
  nextFrame,
  openGlobe,
  screenToGeo,
  waitForIdle,
} from './support/globe.ts';
import { slowRecoverySteps } from './support/recovery.ts';

const BACKENDS = ['webgpu', 'webgl2'] as const;

async function frameNumber(page: Page, index = 0): Promise<number> {
  return page.evaluate((i) => window.vibeglobePlayground?.globes[i]?.frameNumber ?? NaN, index);
}

async function nextAnimationFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test('an invalid camera position at runtime emits a typed error and keeps the view rendered (F050)', async ({
  page,
}) => {
  await openGlobe(page, 'lon=10&lat=45&zoom=3');
  const result = await page.evaluate(() => {
    const hooks = window.vibeglobePlayground;
    try {
      hooks?.globe.jumpTo({ latitudeDeg: 123 });
      return 'accepted';
    } catch (error) {
      return (error as { code?: string }).code;
    }
  });
  expect(result).toBe('invalid-coordinate');
  const events = await page.evaluate(() => window.vibeglobePlayground?.events.filter((e) => e.type === 'error').length);
  expect(events).toBe(1);
  expect(await page.evaluate(() => window.vibeglobePlayground?.globe.camera.latitudeDeg)).toBeCloseTo(45, 9);
  await expectCompleteGlobe(page);
});

test('renders while something changes and stops drawing when nothing changes (F062)', async ({ page }) => {
  await openGlobe(page, 'zoom=2');
  const idle = await waitForIdle(page);
  await page.waitForTimeout(1000);
  expect(await frameNumber(page)).toBe(idle);
  const box = await page.locator('#globe').boundingBox();
  if (!box) throw new Error('no canvas');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  const afterDrag = await waitForIdle(page);
  expect(afterDrag).toBeGreaterThan(idle);
  await page.waitForTimeout(500);
  expect(await frameNumber(page)).toBe(afterDrag);
  // A setting that changes the image: the next frame draws it, then drawing stops again.
  await page.evaluate(() => window.vibeglobePlayground?.globe.setResolutionScale(0.75));
  await nextAnimationFrame(page);
  const afterSetting = await waitForIdle(page);
  expect(afterSetting).toBeGreaterThan(afterDrag);
  expect(afterSetting - afterDrag).toBeLessThanOrEqual(3);
});

test('draws nothing while the tab is hidden and resumes on the next frame when shown (F063)', async ({ page }) => {
  await page.addInitScript(() => {
    let visibility: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { get: () => visibility });
    (window as unknown as { setVisibility: (state: DocumentVisibilityState) => void }).setVisibility = (state) => {
      visibility = state;
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
  await openGlobe(page, 'zoom=2');
  // A continuous animation: the heading turns every 16 ms.
  await page.evaluate(() => {
    let heading = 0;
    setInterval(() => window.vibeglobePlayground?.globe.jumpTo({ headingDeg: (heading += 1) }), 16);
  });
  // Frames follow the animation (on a loaded software GPU a frame can take hundreds of milliseconds).
  await page.waitForFunction(() => (window.vibeglobePlayground?.globe.frameNumber ?? 0) > 1);
  await page.evaluate(() => (window as unknown as { setVisibility: (s: string) => void }).setVisibility('hidden'));
  await page.waitForTimeout(100);
  const hidden = await frameNumber(page);
  await page.waitForTimeout(800);
  expect(await frameNumber(page)).toBe(hidden);
  await page.evaluate(() => (window as unknown as { setVisibility: (s: string) => void }).setVisibility('visible'));
  await nextAnimationFrame(page);
  expect(await frameNumber(page)).toBeGreaterThan(hidden);
  const image = await canvasImage(page);
  const center = ((image.height / 2) * image.width + image.width / 2) * 4;
  expect(Math.abs((image.data[center] ?? 0) - BACKGROUND_RGB[0])).toBeGreaterThan(10);
});

for (const backend of BACKENDS) {
  const feature = backend === 'webgpu' ? 'F066' : 'F067';
  test(`recovers from a ${backend === 'webgpu' ? 'WebGPU device' : 'WebGL2 context'} loss without a reload (${feature})`, async ({
    page,
  }) => {
    await openGlobe(page, `backend=${backend}&lon=12.5&lat=41.9&zoom=4&heading=20`);
    const touchAction = (): Promise<string> =>
      page.locator('#globe').evaluate((canvas) => getComputedStyle(canvas).touchAction);
    // The browser must leave one-finger drags to the controls, on the host's canvas and on a replacement (ADR 0009 §3).
    expect(await touchAction()).toBe('none');
    const before = await page.evaluate(() => window.vibeglobePlayground?.globe.camera);
    await page.evaluate(() => window.vibeglobePlayground?.globe.simulateDeviceLoss());
    await page.waitForFunction(() =>
      window.vibeglobePlayground?.events.some((event) => event.type === 'device-restored'),
    );
    const types = await page.evaluate(() => window.vibeglobePlayground?.events.map((event) => event.type));
    expect(types).toContain('device-lost');
    expect(types?.indexOf('device-lost')).toBeLessThan(types?.indexOf('device-restored') ?? -1);
    expect(await page.evaluate(() => window.vibeglobePlayground?.globe.camera)).toEqual(before);
    expect(await page.evaluate(() => window.vibeglobePlayground?.globe.backend)).toBe(backend);
    await expectCompleteGlobe(page);
    // Input still drives the globe on the new canvas (KB-020).
    const box = await page.locator('#globe').boundingBox();
    if (!box) throw new Error('no canvas');
    const from = { xPx: box.width / 2, yPx: box.height / 2 };
    const to = { xPx: from.xPx + 80, yPx: from.yPx + 30 };
    const grabbed = await screenToGeo(page, from);
    if (!grabbed) throw new Error('center off the globe');
    await page.mouse.move(box.x + from.xPx, box.y + from.yPx);
    await page.mouse.down();
    await page.mouse.move(box.x + to.xPx, box.y + to.yPx, { steps: 4 });
    await page.mouse.up();
    await nextFrame(page);
    const shown = await geoToScreen(page, grabbed);
    expect(Math.hypot(shown.xPx - to.xPx, shown.yPx - to.yPx)).toBeLessThan(1);
    expect(await touchAction()).toBe('none');
    // The page's own pointer listener (the F048 readout) still works on the new canvas.
    await page.evaluate(() => {
      const cursor = document.querySelector('#cursor');
      if (cursor) cursor.textContent = 'stale';
    });
    await page.mouse.move(box.x + from.xPx + 3, box.y + from.yPx + 3);
    await expect(page.locator('#cursor')).toHaveText(/°, /);
  });

  test(`gives up with a typed error after three losses within a minute on ${backend} (KB-022)`, async ({ page }) => {
    await openGlobe(page, `backend=${backend}&zoom=2`);
    for (let loss = 1; loss <= 3; loss++) {
      await page.evaluate(() => window.vibeglobePlayground?.globe.simulateDeviceLoss());
      await page.waitForFunction(
        (n) => window.vibeglobePlayground?.events.filter((event) => event.type === 'device-restored').length === n,
        loss,
      );
    }
    await page.evaluate(() => window.vibeglobePlayground?.globe.simulateDeviceLoss());
    await page.waitForFunction(() => window.vibeglobePlayground?.events.some((event) => event.type === 'error'));
    // Read in the page: an Error crossing into the test keeps only its message.
    const code = await page.evaluate(
      () =>
        (window.vibeglobePlayground?.events.find((event) => event.type === 'error')?.payload as { code?: string }).code,
    );
    expect(code).toBe('renderer-failed');
    // A static message takes the canvas's place (ADR 0010 §8).
    await expect(page.locator('.vibeglobe-renderer-failed')).toHaveText(/cannot be shown/);
    await expect(page.locator('.vibeglobe-renderer-failed')).toHaveAttribute('role', 'alert');
  });
}

for (const step of ['device request', 'pipeline warm-up'] as const) {
  test(`destroy() during the WebGPU recovery's ${step} leaves no canvas, message or controls behind (KB-035)`, async ({
    page,
  }) => {
    await page.addInitScript(slowRecoverySteps);
    await openGlobe(page, 'backend=webgpu&zoom=3');
    await page.evaluate(() => {
      document.querySelector('#app canvas')?.setAttribute('data-original', '');
      (window as unknown as { slowRecovery?: boolean }).slowRecovery = true;
      window.vibeglobePlayground?.globe.simulateDeviceLoss();
    });
    await page.waitForFunction((name) => (window as unknown as { recoveryStep?: string }).recoveryStep === name, step);
    // The page still shows the old canvas: the new one replaces it only after the warm-up (ADR 0010 §8).
    expect(await page.locator('#app canvas').evaluate((canvas) => canvas.hasAttribute('data-original'))).toBe(true);
    await page.evaluate(() => window.vibeglobePlayground?.globe.destroy());
    await page.waitForTimeout(3000);
    const left = await page.evaluate(() => ({
      canvases: document.querySelectorAll('#app canvas').length,
      alerts: document.querySelectorAll('#app [role="alert"]').length,
      events: window.vibeglobePlayground?.events.map((event) => event.type),
    }));
    expect(left.canvases).toBe(0);
    expect(left.alerts).toBe(0);
    expect(left.events).not.toContain('device-restored');
    expect(left.events).not.toContain('error');
    expect(await page.evaluate(() => window.vibeglobePlayground?.globe.resourceCounts().contexts)).toBe(0);
  });
}

test('a recovery that finds WebGPU gone switches to WebGL2 and reports backend-fallback (KB-049)', async ({ page }) => {
  await openGlobe(page, 'zoom=3');
  expect(await page.evaluate(() => window.vibeglobePlayground?.globe.backend)).toBe('webgpu');
  await page.evaluate(() => {
    // As after a GPU-process crash that leaves WebGPU blocked: the recovery's adapter request finds none.
    const gpu = navigator.gpu as GPU | undefined;
    if (gpu) gpu.requestAdapter = () => Promise.resolve(null);
    window.vibeglobePlayground?.globe.simulateDeviceLoss();
  });
  await page.waitForFunction(() =>
    window.vibeglobePlayground?.events.some((event) => event.type === 'device-restored'),
  );
  expect(await page.evaluate(() => window.vibeglobePlayground?.globe.backend)).toBe('webgl2');
  const types = await page.evaluate(() => window.vibeglobePlayground?.events.map((event) => event.type));
  expect(types).toContain('backend-fallback');
  expect(types?.indexOf('backend-fallback')).toBeGreaterThan(types?.indexOf('device-lost') ?? Infinity);
  await waitForIdle(page);
  await expectCompleteGlobe(page);
});

test('a recovery whose WebGPU fails its self-test reports one backend-fallback naming the self-test (KB-052)', async ({
  page,
}) => {
  // Once `breakViews` is set, every texture view WebGPU creates is invalid: the recovery's self-test fails.
  await page.addInitScript(() => {
    const prototype = (globalThis as { GPUTexture?: { prototype: GPUTexture } }).GPUTexture?.prototype;
    if (!prototype) return;
    const createView = prototype.createView;
    prototype.createView = function (this: GPUTexture, descriptor?: GPUTextureViewDescriptor): GPUTextureView {
      const broken = (window as unknown as { breakViews?: boolean }).breakViews === true;
      return createView.call(this, broken ? { ...descriptor, mipLevelCount: 99 } : descriptor);
    };
  });
  await openGlobe(page, 'zoom=3');
  expect(await page.evaluate(() => window.vibeglobePlayground?.globe.backend)).toBe('webgpu');
  await page.evaluate(() => {
    (window as unknown as { breakViews?: boolean }).breakViews = true;
    window.vibeglobePlayground?.globe.simulateDeviceLoss();
  });
  await page.waitForFunction(() =>
    window.vibeglobePlayground?.events.some((event) => event.type === 'device-restored'),
  );
  expect(await page.evaluate(() => window.vibeglobePlayground?.globe.backend)).toBe('webgl2');
  const fallbacks = await page.evaluate(() =>
    window.vibeglobePlayground?.events
      .filter((event) => event.type === 'backend-fallback')
      .map((event) => JSON.stringify(event.payload)),
  );
  expect(fallbacks).toHaveLength(1);
  expect(fallbacks?.[0]).toContain('self-test');
  await waitForIdle(page);
  await expectCompleteGlobe(page);
});

test('a WebGPU device lost again during the recovery warm-up is recovered too, not left blank (KB-044)', async ({
  page,
}) => {
  await page.addInitScript(slowRecoverySteps);
  await openGlobe(page, 'backend=webgpu&zoom=3');
  await page.evaluate(() => {
    (window as unknown as { slowRecovery?: boolean }).slowRecovery = true;
    window.vibeglobePlayground?.globe.simulateDeviceLoss();
  });
  await page.waitForFunction(
    () => (window as unknown as { recoveryStep?: string }).recoveryStep === 'pipeline warm-up',
  );
  await page.evaluate(() => window.vibeglobePlayground?.globe.simulateDeviceLoss());
  // The second loss is handled as a loss: a new recovery that ends with a drawn globe, or a failure that says so.
  await page.waitForFunction(
    () => {
      const events = window.vibeglobePlayground?.events.map((event) => event.type) ?? [];
      return events.filter((type) => type === 'device-lost').length === 2 && events.at(-1) === 'device-restored';
    },
    null,
    { timeout: 30_000 },
  );
  await page.evaluate(() => {
    (window as unknown as { slowRecovery?: boolean }).slowRecovery = false;
  });
  expect(await page.evaluate(() => window.vibeglobePlayground?.globe.resourceCounts().contexts)).toBe(1);
  await expectCompleteGlobe(page);
});

test('replacing geometry does not leak WebGL2 vertex arrays (KB-021)', async ({ page }) => {
  await openGlobe(page, 'backend=webgl2&lon=10&lat=45&zoom=4');
  const counts = (): Promise<{ meshes: number; vertexArrays: number } | undefined> =>
    page.evaluate(() => window.vibeglobePlayground?.globe.resourceCounts());
  const before = await counts();
  // Twenty rounds of ten new debug quads each: every round creates and disposes ten geometries.
  for (let round = 0; round < 20; round++) {
    await page.evaluate((r) => {
      const shapes = Array.from({ length: 10 }, (_, i) => {
        const lon = 5 + i + r * 0.01;
        return {
          corners: [
            { longitudeDeg: lon, latitudeDeg: 44 },
            { longitudeDeg: lon + 0.5, latitudeDeg: 44 },
            { longitudeDeg: lon + 0.5, latitudeDeg: 44.5 },
            { longitudeDeg: lon, latitudeDeg: 44.5 },
          ] as [GeoPosition, GeoPosition, GeoPosition, GeoPosition],
          colorRgb: [1, 0, 0] as [number, number, number],
        };
      });
      window.vibeglobePlayground?.globe.setDebugShapes(shapes);
    }, round);
    await waitForIdle(page);
  }
  const after = await counts();
  // One vertex array per mesh drawn, plus the backend's own: never one per geometry ever created.
  expect((after?.vertexArrays ?? 0) - (after?.meshes ?? 0)).toBeLessThanOrEqual(
    (before?.vertexArrays ?? 0) - (before?.meshes ?? 0) + 2,
  );
});

test('destroy() frees GPU resources, listeners and frames, and later calls throw a typed error (F068)', async ({
  page,
}) => {
  await page.addInitScript(() => {
    // Tracks listeners registered by engine code (paths under packages/), to prove destroy removes all of them.
    const active = new Set<string>();
    const fromEngine = (): boolean => /\/packages\/(core|renderer|controls)\//.test(new Error().stack ?? '');
    const key = (target: EventTarget, type: string, listener: unknown): string =>
      `${String((target as { constructor: { name: string } }).constructor.name)}:${type}:${String(listener)}`;
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (fromEngine()) active.add(key(this, type, listener));
      add.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) {
      active.delete(key(this, type, listener));
      remove.call(this, type, listener, options);
    };
    // Observers observing something, as a set: an engine may call observe() again on the same observer (WebKit has no
    // device-pixel-content-box, so the renderer retries with the default box).
    const observers = new Set<ResizeObserver>();
    const observe = ResizeObserver.prototype.observe;
    const disconnect = ResizeObserver.prototype.disconnect;
    ResizeObserver.prototype.observe = function (this: ResizeObserver, ...args: Parameters<ResizeObserver['observe']>) {
      observe.apply(this, args);
      observers.add(this);
    };
    ResizeObserver.prototype.disconnect = function (this: ResizeObserver) {
      observers.delete(this);
      disconnect.call(this);
    };
    (window as unknown as { engineListeners: () => number[] }).engineListeners = () => [active.size, observers.size];
  });
  await openGlobe(page, 'zoom=3');
  const listeners = (): Promise<number[]> =>
    page.evaluate(() => (window as unknown as { engineListeners: () => number[] }).engineListeners());
  const [before] = await listeners();
  expect(before).toBeGreaterThan(0);
  const counts = await page.evaluate(() => window.vibeglobePlayground?.globe.resourceCounts());
  expect(counts?.meshes).toBeGreaterThan(0);
  expect(counts?.contexts).toBe(1);
  await page.evaluate(() => window.vibeglobePlayground?.globe.destroy());
  // Counted from what the renderer still holds; the device or context is released (KB-023).
  await page.waitForFunction(() => window.vibeglobePlayground?.globe.resourceCounts().contexts === 0);
  expect(await page.evaluate(() => window.vibeglobePlayground?.globe.resourceCounts())).toEqual({
    meshes: 0,
    textures: 0,
    gpuBytes: 0,
    vertexArrays: 0,
    contexts: 0,
  });
  expect(await listeners()).toEqual([0, 0]);
  await expect(page.locator('#globe')).toHaveCount(0);
  const frames = await frameNumber(page);
  await page.waitForTimeout(300);
  expect(await frameNumber(page)).toBe(frames);
  const error = await page.evaluate(() => {
    try {
      window.vibeglobePlayground?.globe.jumpTo({ zoom: 2 });
      return 'no error';
    } catch (e) {
      return `${(e as { name: string }).name}:${(e as { code: string }).code}`;
    }
  });
  expect(error).toBe('GlobeError:destroyed');
});

for (const backend of BACKENDS) {
  test(`two engine instances on one page run independently on ${backend} (F069)`, async ({ page }) => {
    await openGlobe(page, `backend=${backend}&scenario=two-globes&zoom=1`);
    await page.evaluate(async () => window.vibeglobePlayground?.globes[1]?.ready);
    await waitForIdle(page);
    const second = await page.evaluate(() => window.vibeglobePlayground?.globes[1]?.camera);
    const secondFrames = await frameNumber(page, 1);
    await page.evaluate(() => window.vibeglobePlayground?.globes[0]?.jumpTo({ longitudeDeg: -70, zoom: 2 }));
    await waitForIdle(page);
    expect(await page.evaluate(() => window.vibeglobePlayground?.globes[1]?.camera)).toEqual(second);
    expect(await frameNumber(page, 1)).toBe(secondFrames);
    await page.evaluate(() => window.vibeglobePlayground?.globes[0]?.destroy());
    await page.evaluate(() => window.vibeglobePlayground?.globes[1]?.jumpTo({ longitudeDeg: 100 }));
    await page.waitForFunction(
      (frames) => (window.vibeglobePlayground?.globes[1]?.frameNumber ?? 0) > frames,
      secondFrames,
    );
    await page.waitForTimeout(500);
    await expectCompleteGlobe(page, 1, '#globe-2');
  });
}

test.describe('on a 2x display', () => {
  test.use({ deviceScaleFactor: 2 });
  test('a canvas the host passes in fills its container and picks where it is shown (KB-055)', async ({ page }) => {
    await openGlobe(page, 'scenario=two-globes&lon=20&lat=10&zoom=1');
    await page.evaluate(async () => window.vibeglobePlayground?.globes[1]?.ready);
    await page.evaluate(() => window.vibeglobePlayground?.globes[1]?.jumpTo({ longitudeDeg: 20, latitudeDeg: 10 }));
    await waitForIdle(page);
    const state = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('#globe-2');
      const container = canvas?.parentElement;
      const width = canvas?.clientWidth ?? 0;
      const height = canvas?.clientHeight ?? 0;
      return {
        canvas: [width, height],
        container: [container?.clientWidth, container?.clientHeight],
        backing: [canvas?.width, canvas?.height],
        center: window.vibeglobePlayground?.globes[1]?.screenToGeo({ xPx: width / 2, yPx: height / 2 }),
      };
    });
    expect(state.canvas).toEqual(state.container);
    expect(state.backing).toEqual(state.canvas.map((size) => Math.round(size * 2)));
    expect(state.center?.longitudeDeg).toBeCloseTo(20, 6);
    expect(state.center?.latitudeDeg).toBeCloseTo(10, 6);
  });
});

for (const backend of BACKENDS) {
  test(`a host canvas can be given to a new globe after the previous one was destroyed on ${backend} (KB-059)`, async ({
    page,
  }) => {
    await openGlobe(page, `backend=${backend}&zoom=1`);
    const result = await page.evaluate(async () => {
      const hooks = window.vibeglobePlayground;
      if (!hooks) throw new Error('no playground');
      // As a framework does in development: mount, clean up, mount again with the same canvas element.
      const first = hooks.mount();
      await first.globe.ready;
      first.unmount();
      const second = hooks.mount(first.canvas);
      // The given canvas is in this element now; whichever canvas draws must be the one shown there.
      const host = first.canvas.parentElement;
      try {
        await second.globe.ready;
        const frame = await second.globe.captureFrame();
        let drawn = 0;
        for (let i = 3; i < frame.rgba.length; i += 4) if ((frame.rgba[i] ?? 0) > 0) drawn++;
        return { ready: true, drawn, backend: second.globe.backend, canvases: host?.querySelectorAll('canvas').length };
      } catch (error) {
        return { ready: false, error: String(error) };
      } finally {
        second.unmount();
      }
    });
    expect(result).toMatchObject({ ready: true, backend, canvases: 1 });
    expect(result.drawn).toBeGreaterThan(1000);
  });
}

for (const [first, second] of [
  ['webgpu', 'webgl2'],
  ['webgl2', 'webgpu'],
] as const) {
  test(`a host canvas that drew with ${first} can be given to a new globe on ${second} (KB-063)`, async ({ page }) => {
    await openGlobe(page, 'zoom=1');
    const result = await page.evaluate(
      async ([firstBackend, secondBackend]) => {
        const hooks = window.vibeglobePlayground;
        if (!hooks) throw new Error('no playground');
        // A host with a backend switch that mounts again on the same canvas element.
        const before = hooks.mount(undefined, firstBackend);
        await before.globe.ready;
        before.unmount();
        const after = hooks.mount(before.canvas, secondBackend);
        // The given canvas is in this element now; whichever canvas draws must be the one shown there.
        const host = before.canvas.parentElement;
        try {
          await after.globe.ready;
          const frame = await after.globe.captureFrame();
          let drawn = 0;
          for (let i = 3; i < frame.rgba.length; i += 4) if ((frame.rgba[i] ?? 0) > 0) drawn++;
          return {
            ready: true,
            drawn,
            backend: after.globe.backend,
            canvases: host?.querySelectorAll('canvas').length,
          };
        } catch (error) {
          return { ready: false, error: String(error) };
        } finally {
          after.unmount();
        }
      },
      [first, second] as const,
    );
    expect(result).toMatchObject({ ready: true, backend: second, canvases: 1 });
    expect(result.drawn).toBeGreaterThan(1000);
  });
}

test('a host canvas whose WebGPU start fell back to WebGL2 can be given to a new globe (KB-064)', async ({ page }) => {
  // An adapter whose device request fails: three.js falls back to WebGL2 on the same canvas.
  await page.addInitScript(() => {
    const adapter = (globalThis as { GPUAdapter?: { prototype: GPUAdapter } }).GPUAdapter?.prototype;
    if (adapter) adapter.requestDevice = () => Promise.reject(new Error('no device'));
  });
  await openGlobe(page, 'backend=webgl2&zoom=1');
  const result = await page.evaluate(async () => {
    const hooks = window.vibeglobePlayground;
    if (!hooks) throw new Error('no playground');
    const forced = hooks.mount(undefined, 'webgpu');
    const firstError = await forced.globe.ready.then(
      () => 'started',
      (error: { code?: string }) => error.code,
    );
    forced.unmount();
    const retry = hooks.mount(forced.canvas, 'auto');
    // The given canvas is in this element now; whichever canvas draws must be the one shown there.
    const host = forced.canvas.parentElement;
    try {
      await retry.globe.ready;
      const frame = await retry.globe.captureFrame();
      let drawn = 0;
      for (let i = 3; i < frame.rgba.length; i += 4) if ((frame.rgba[i] ?? 0) > 0) drawn++;
      return {
        firstError,
        ready: true,
        drawn,
        backend: retry.globe.backend,
        canvases: host?.querySelectorAll('canvas').length,
      };
    } catch (error) {
      return { firstError, ready: false, error: String(error) };
    } finally {
      retry.unmount();
    }
  });
  expect(result).toMatchObject({ firstError: 'unsupported-device', ready: true, backend: 'webgl2', canvases: 1 });
  expect(result.drawn).toBeGreaterThan(1000);
});

test('resizing renders at the new size, centered, never stretched or blank (F070)', async ({ page }) => {
  await openGlobe(page, 'lon=20&lat=10&zoom=1');
  // The page's text overlays lie over the canvas; with wider fonts they reached the measured center column.
  await page.addStyleTag({ content: '#status, #cursor { visibility: hidden !important; }' });
  for (const [width, height] of [
    [900, 700],
    [1300, 500],
    [640, 640],
    [1280, 720],
  ] as const) {
    // Rapid changes first, then the final size of this round.
    await page.setViewportSize({ width: width - 50, height: height - 30 });
    await page.setViewportSize({ width, height });
    // What the page shows right after the resize, before the engine has gone idle: a drawn frame, not the cleared
    // canvas (KB-013). A page screenshot, since this is about what the browser composites, not about a frame.
    const immediate = await pageImage(page, '#globe');
    const middle = (Math.floor(immediate.height / 2) * immediate.width + Math.floor(immediate.width / 2)) * 4;
    expect(
      Math.abs((immediate.data[middle] ?? 0) - BACKGROUND_RGB[0]) +
        Math.abs((immediate.data[middle + 2] ?? 0) - BACKGROUND_RGB[2]),
    ).toBeGreaterThan(12);
    await expectCompleteGlobe(page);
    const state = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('#globe');
      const globe = window.vibeglobePlayground?.globe;
      const center = globe?.screenToGeo({ xPx: (canvas?.clientWidth ?? 0) / 2, yPx: (canvas?.clientHeight ?? 0) / 2 });
      return {
        backing: [canvas?.width, canvas?.height],
        css: [canvas?.clientWidth, canvas?.clientHeight],
        ratio: devicePixelRatio,
        center,
      };
    });
    expect(state.backing).toEqual(state.css.map((size) => Math.round((size ?? 0) * state.ratio)));
    expect(state.center?.longitudeDeg).toBeCloseTo(20, 6);
    expect(state.center?.latitudeDeg).toBeCloseTo(10, 6);
    // Not stretched: the globe's horizontal and vertical diameters through the center agree within 2 px.
    const image = await canvasImage(page);
    const isGlobe = (x: number, y: number): boolean => {
      const k = (y * image.width + x) * 4;
      return (
        Math.abs((image.data[k] ?? 0) - BACKGROUND_RGB[0]) + Math.abs((image.data[k + 2] ?? 0) - BACKGROUND_RGB[2]) > 12
      );
    };
    const cx = Math.floor(image.width / 2);
    const cy = Math.floor(image.height / 2);
    let horizontal = 0;
    let vertical = 0;
    for (let x = 0; x < image.width; x++) if (isGlobe(x, cy)) horizontal++;
    for (let y = 0; y < image.height; y++) if (isGlobe(cx, y)) vertical++;
    expect(
      Math.abs(horizontal - vertical),
      JSON.stringify({ size: [width, height], image: [image.width, image.height], horizontal, vertical, state }),
    ).toBeLessThanOrEqual(2);
  }
});

for (const backend of BACKENDS) {
  test(`a padded container renders and picks in the canvas's own box on ${backend} (KB-048)`, async ({ page }) => {
    await openGlobe(page, `backend=${backend}&lon=20&lat=10&zoom=1`);
    // The canvas fills the container's content box; padding is not part of it.
    await page.addStyleTag({ content: '#app { box-sizing: border-box; padding: 20px 40px; }' });
    await page.waitForFunction(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('#globe');
      return canvas !== null && canvas.width === Math.round(canvas.clientWidth * devicePixelRatio);
    });
    await waitForIdle(page);
    const state = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('#globe');
      const globe = window.vibeglobePlayground?.globe;
      const width = canvas?.clientWidth ?? 0;
      const height = canvas?.clientHeight ?? 0;
      return {
        backing: [canvas?.width, canvas?.height],
        css: [width, height],
        ratio: devicePixelRatio,
        center: globe?.screenToGeo({ xPx: width / 2, yPx: height / 2 }),
        projected: globe?.geoToScreen({ longitudeDeg: 20, latitudeDeg: 10 }),
      };
    });
    expect(state.backing).toEqual(state.css.map((size) => Math.round(size * state.ratio)));
    expect(state.center?.longitudeDeg).toBeCloseTo(20, 6);
    expect(state.center?.latitudeDeg).toBeCloseTo(10, 6);
    expect(state.projected?.xPx).toBeCloseTo((state.css[0] ?? 0) / 2, 3);
    expect(state.projected?.yPx).toBeCloseTo((state.css[1] ?? 0) / 2, 3);
    // Not stretched: the globe's horizontal and vertical diameters through the center agree within 2 px.
    const image = await canvasImage(page);
    const isGlobe = (x: number, y: number): boolean => {
      const k = (y * image.width + x) * 4;
      return (
        Math.abs((image.data[k] ?? 0) - BACKGROUND_RGB[0]) + Math.abs((image.data[k + 2] ?? 0) - BACKGROUND_RGB[2]) > 12
      );
    };
    let horizontal = 0;
    let vertical = 0;
    for (let x = 0; x < image.width; x++) if (isGlobe(x, Math.floor(image.height / 2))) horizontal++;
    for (let y = 0; y < image.height; y++) if (isGlobe(Math.floor(image.width / 2), y)) vertical++;
    expect(Math.abs(horizontal - vertical), JSON.stringify({ horizontal, vertical, state })).toBeLessThanOrEqual(2);
  });
}

test('destroy() leaves no WebGL2 resource behind, the output pass included (KB-030)', async ({ page }) => {
  await openGlobe(page, 'backend=webgl2&zoom=3');
  await page.evaluate(() => window.vibeglobePlayground?.globe.destroy());
  await page.waitForFunction(() => window.vibeglobePlayground?.globe.resourceCounts().contexts === 0);
  expect(await page.evaluate(() => window.vibeglobePlayground?.globe.resourceCounts())).toEqual({
    meshes: 0,
    textures: 0,
    gpuBytes: 0,
    vertexArrays: 0,
    contexts: 0,
  });
});
