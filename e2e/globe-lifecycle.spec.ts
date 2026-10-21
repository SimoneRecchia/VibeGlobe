import { expect, test, type Page } from '@playwright/test';
import type { GeoPosition } from '@vibeglobe/core';
import {
  BACKGROUND_RGB,
  canvasImage,
  expectCompleteGlobe,
  geoToScreen,
  openGlobe,
  screenToGeo,
  waitForIdle,
} from './support/globe.ts';

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
  await page.waitForTimeout(300);
  expect(await frameNumber(page)).toBeGreaterThan(1);
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
    const shown = await geoToScreen(page, grabbed);
    expect(Math.hypot(shown.xPx - to.xPx, shown.yPx - to.yPx)).toBeLessThan(1);
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
  });
}

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
    let observers = 0;
    const observe = ResizeObserver.prototype.observe;
    const disconnect = ResizeObserver.prototype.disconnect;
    ResizeObserver.prototype.observe = function (this: ResizeObserver, ...args: Parameters<ResizeObserver['observe']>) {
      observers++;
      observe.apply(this, args);
    };
    ResizeObserver.prototype.disconnect = function (this: ResizeObserver) {
      observers--;
      disconnect.call(this);
    };
    (window as unknown as { engineListeners: () => number[] }).engineListeners = () => [active.size, observers];
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
    // The frame right after the resize, before the engine has gone idle: drawn, not the cleared canvas (KB-013).
    const immediate = await canvasImage(page);
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
