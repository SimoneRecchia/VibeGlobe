// The Vue adapter's reactive props on a running engine (F474) and its child components (F476), on the live example
// page (apps/adapter-examples/src/LiveApp.vue).
import { expect, test, type Page } from '@playwright/test';
import { openExample } from './support/adapters.ts';

test.use({ viewport: { width: 480, height: 360 } });

interface Live {
  set(changes: Record<string, unknown>): Promise<void>;
  replaceZoomControl(): void;
  offline: { mode: string };
  extras(): {
    layers(): Promise<{ stack: { order: readonly string[] } }>;
    ui(): Promise<{ controls(): { id: string }[] }>;
  };
}

async function set(page: Page, changes: Record<string, unknown>): Promise<void> {
  await page.evaluate((c) => (window as unknown as { adapterExampleLive: Live }).adapterExampleLive.set(c), changes);
}

/** Waits until the engine is idle: no frame for 300 ms. */
async function idle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const globe = window.adapterExample?.globes()[0];
        let timer = setTimeout(done, 300);
        const stop = globe?.on('frame', () => {
          clearTimeout(timer);
          timer = setTimeout(done, 300);
        });
        function done(): void {
          stop?.();
          resolve();
        }
        globe?.requestRender();
      }),
  );
}

/** Whether the frame shows a strongly red or blue pixel near a position. */
async function colorAt(page: Page, lon: number, lat: number, color: 'red' | 'blue' | 'green'): Promise<boolean> {
  return page.evaluate(
    async ([longitudeDeg, latitudeDeg, wanted]) => {
      const globe = window.adapterExample?.globes()[0];
      if (globe === undefined) throw new Error('no globe');
      const point = globe.geoToScreen({ longitudeDeg, latitudeDeg });
      const frame = await globe.captureFrame();
      if (point === undefined) return false;
      const scale = frame.widthPx / (document.querySelector('.vibeglobe')?.clientWidth ?? frame.widthPx);
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const i = ((Math.round(point.yPx * scale) + dy) * frame.widthPx + Math.round(point.xPx * scale) + dx) * 4;
          const [r, g, b] = [frame.rgba[i] ?? 0, frame.rgba[i + 1] ?? 0, frame.rgba[i + 2] ?? 0];
          if (wanted === 'red' && r > 180 && g < 90 && b < 90) return true;
          if (wanted === 'blue' && b > 150 && b > r + 60) return true;
          if (wanted === 'green' && g > 150 && g > r + 60 && g > b + 60) return true;
        }
      return false;
    },
    [lon, lat, color] as const,
  );
}

test('reactive props change the running engine in place, without a remount or downloading again (F474)', async ({
  page,
}) => {
  const tiles: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/fixture-tiles/')) tiles.push(new URL(request.url()).pathname);
  });
  await openExample(page, 'live.html?backend=webgl2');
  await idle(page);
  await page.evaluate(() => {
    (window as unknown as { kept: unknown[] }).kept = [
      window.adapterExample?.globes()[0],
      document.querySelector('.vibeglobe canvas'),
    ];
  });
  const state = (): Promise<{ mode: string; tilt: number; layers: string[]; network: string }> =>
    page.evaluate(() => {
      const globe = window.adapterExample?.globes()[0];
      const live = (window as unknown as { adapterExampleLive: Live }).adapterExampleLive;
      return {
        mode: globe?.viewMode ?? '',
        tilt: globe?.camera.tiltDeg ?? NaN,
        layers: (globe?.imageryLayers.list() ?? []).map((l) => `${l.id}:${l.visible}:${l.opacity}`),
        network: live.offline.mode,
      };
    });
  expect(await state()).toMatchObject({ mode: 'auto', layers: ['world:true:1', 'levels:true:0.5'], network: 'hybrid' });
  // View mode.
  await set(page, { viewMode: '2d' });
  await idle(page);
  expect(await state()).toMatchObject({ mode: '2d', tilt: 0 });
  await set(page, { viewMode: '3d' });
  await idle(page);
  expect((await state()).mode).toBe('manual');
  expect((await state()).tilt).toBeGreaterThan(10);
  await set(page, { viewMode: 'auto' });
  await idle(page);
  // Layers: look and order, with no tile downloaded again.
  const before = tiles.length;
  await set(page, {
    layers: [
      { id: 'levels', visible: true, opacity: 0.8 },
      { id: 'world', visible: true, opacity: 0.6 },
    ],
  });
  await idle(page);
  expect((await state()).layers).toEqual(['levels:true:0.8', 'world:true:0.6']);
  await set(page, {
    layers: [
      { id: 'world', visible: true, opacity: 1 },
      { id: 'levels', visible: false, opacity: 0.5 },
    ],
  });
  await idle(page);
  expect((await state()).layers).toEqual(['world:true:1', 'levels:false:0.5']);
  expect(tiles.length).toBe(before);
  // Network mode: offline-only touches no network, even for a new view; hybrid again loads it.
  await set(page, { networkMode: 'offline' });
  expect((await state()).network).toBe('offline');
  await set(page, { view: { longitudeDeg: -70, latitudeDeg: -30, zoom: 6 } });
  await idle(page);
  expect(tiles.length).toBe(before);
  await set(page, { networkMode: 'hybrid' });
  await page.evaluate(() => window.adapterExample?.globes()[0]?.jumpTo({ zoom: 6.5 }));
  await expect.poll(() => tiles.length).toBeGreaterThan(before);
  // Quality preset: the running engine takes each preset's settings (resolution scale, level of detail).
  for (const [preset, scale, screenError] of [
    ['low', 0.5, 4],
    ['ultra', 1.25, 0.75],
  ] as const) {
    await set(page, { qualityPreset: preset });
    await expect
      .poll(() => page.evaluate(() => window.adapterExample?.globes()[0]?.qualitySettings))
      .toMatchObject({ resolutionScale: scale, maxScreenErrorPx: screenError });
  }
  // Same engine, same canvas; no tile requested twice.
  const same = await page.evaluate(() => {
    const [globe, canvas] = (window as unknown as { kept: unknown[] }).kept;
    return globe === window.adapterExample?.globes()[0] && canvas === document.querySelector('.vibeglobe canvas');
  });
  expect(same).toBe(true);
  expect(tiles.length).toBe(new Set(tiles).size);
});

test('child components add, update and remove data layers, markers and controls (F476)', async ({ page }) => {
  await openExample(page, 'live.html?backend=webgl2');
  const lists = (): Promise<{ layers: readonly string[]; controls: string[]; meshes: number }> =>
    page.evaluate(async () => {
      const live = (window as unknown as { adapterExampleLive: Live }).adapterExampleLive;
      const extras = live.extras();
      const [layers, ui] = await Promise.all([extras.layers(), extras.ui()]);
      return {
        layers: [...layers.stack.order],
        controls: ui.controls().map((c) => c.id),
        meshes: window.adapterExample?.globes()[0]?.resourceCounts().meshes ?? 0,
      };
    });
  const empty = await lists();
  expect(empty.layers).toEqual([]);
  expect(empty.controls).toEqual([]);
  // A data layer with features.
  const feature = (lon: number, lat: number): unknown => ({
    type: 'Feature',
    id: 'p',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {},
  });
  await set(page, { children: { points: true }, points: [feature(12.5, 41.9)] });
  await expect.poll(async () => (await lists()).layers).toEqual(['points']);
  await idle(page);
  expect(await colorAt(page, 12.5, 41.9, 'red')).toBe(true);
  await set(page, { points: [feature(14, 43)] });
  await idle(page);
  expect(await colorAt(page, 14, 43, 'red')).toBe(true);
  expect(await colorAt(page, 12.5, 41.9, 'red')).toBe(false);
  // A marker that moves.
  await set(page, { children: { marker: true }, marker: { longitudeDeg: 10, latitudeDeg: 40 } });
  await expect.poll(async () => (await lists()).layers.length).toBe(2);
  await idle(page);
  expect(await colorAt(page, 10, 40, 'blue')).toBe(true);
  await set(page, { marker: { longitudeDeg: 16, latitudeDeg: 40 } });
  await idle(page);
  expect(await colorAt(page, 16, 40, 'blue')).toBe(true);
  // UI controls, one replaced by a new instance.
  await set(page, { children: { zoom: true, scale: true } });
  await expect.poll(async () => (await lists()).controls.sort()).toEqual(['scale', 'zoom']);
  await expect(page.locator('.vg-ui__corner--top-right [data-control="zoom"]')).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as { adapterExampleLive: Live }).adapterExampleLive.replaceZoomControl(),
  );
  await expect(page.locator('.vg-ui__corner--top-left [data-control="zoom"]')).toBeVisible();
  // Removal releases everything: no layer, no control, the meshes of the layers freed.
  const full = await lists();
  await set(page, { children: { points: false, marker: false, zoom: false, scale: false } });
  await expect.poll(async () => (await lists()).layers).toEqual([]);
  await idle(page);
  const after = await lists();
  expect(after.controls).toEqual([]);
  expect(after.meshes).toBeLessThan(full.meshes);
  await expect(page.locator('[data-control]')).toHaveCount(0);
  // An imagery source added at runtime, its look changed in place, then removed with its tiles.
  const imageryIds = (): Promise<string[]> =>
    page.evaluate(
      () =>
        window.adapterExample
          ?.globes()[0]
          ?.imageryLayers.list()
          .map((layer) => layer.id) ?? [],
    );
  const textures = (): Promise<number> =>
    page.evaluate(() => window.adapterExample?.globes()[0]?.resourceCounts().textures ?? 0);
  await set(page, { children: { overlay: true } });
  await expect.poll(imageryIds).toEqual(['world', 'levels', 'overlay']);
  await expect.poll(() => colorAt(page, 12.5, 41.9, 'green'), { timeout: 30_000 }).toBe(true);
  await set(page, { overlay: { opacity: 0.3 } });
  await idle(page);
  expect(await colorAt(page, 12.5, 41.9, 'green')).toBe(false);
  await set(page, { overlay: { opacity: 1, visible: false } });
  await idle(page);
  expect(await colorAt(page, 12.5, 41.9, 'green')).toBe(false);
  await set(page, { overlay: { visible: true } });
  await expect.poll(() => colorAt(page, 12.5, 41.9, 'green'), { timeout: 30_000 }).toBe(true);
  await idle(page);
  const withOverlay = await textures();
  await set(page, { children: { overlay: false } });
  await expect.poll(imageryIds).toEqual(['world', 'levels']);
  await idle(page);
  expect(await colorAt(page, 12.5, 41.9, 'green')).toBe(false);
  // Its tiles' textures are released.
  expect(await textures()).toBeLessThan(withOverlay);
});

test('the composables follow a flight and the view mode, within the frame budget over a 30-second flight (F475)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openExample(page, 'live.html?backend=webgl2');
  const readout = page.locator('.readout');
  // The view-mode composable follows the engine's mode.
  await set(page, { viewMode: '2d' });
  await expect(readout).toHaveAttribute('data-view-mode', '2d');
  await set(page, { viewMode: '3d' });
  await expect(readout).toHaveAttribute('data-view-mode', 'manual');
  await set(page, { viewMode: 'auto' });
  await expect(readout).toHaveAttribute('data-view-mode', 'auto');
  // A 30-second flight: from each frame event to the end of Vue's re-render of the readout (the composables' updates
  // and the render), the work stays within the engine's CPU frame budget (quality/budgets.json, 2 ms p95).
  const result = await page.evaluate(async () => {
    const globe = window.adapterExample?.globes()[0];
    if (globe === undefined) throw new Error('no globe');
    const tails: number[] = [];
    let start = 0;
    // The frame event comes before the camera event; the composables' handlers queue Vue's update as a microtask
    // during the camera event, ahead of the one queued here, which so runs after Vue has re-rendered.
    const stopFrame = globe.on('frame', () => void (start = performance.now()));
    const stopCamera = globe.on('camera-change', () => {
      void Promise.resolve()
        .then(() => undefined)
        .then(() => void tails.push(performance.now() - start));
    });
    const stop = (): void => {
      stopFrame();
      stopCamera();
    };
    await globe.flyTo({ longitudeDeg: -74, latitudeDeg: 40.7, zoom: 9 }, { durationMs: 30_000 });
    stop();
    const camera = globe.camera;
    const shown = document.querySelector<HTMLElement>('.readout')?.dataset ?? {};
    const sorted = [...tails].sort((a, b) => a - b);
    return {
      frames: tails.length,
      p95: sorted[Math.floor(sorted.length * 0.95)] ?? Infinity,
      shown: [Number(shown['longitude']), Number(shown['latitude']), Number(shown['zoom'])],
      camera: [camera.longitudeDeg, camera.latitudeDeg, camera.zoom],
    };
  });
  expect(result.frames).toBeGreaterThan(30);
  expect(result.p95).toBeLessThan(2);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const shown = document.querySelector<HTMLElement>('.readout')?.dataset ?? {};
        const camera = window.adapterExample?.globes()[0]?.camera;
        return Math.abs(Number(shown['longitude']) - (camera?.longitudeDeg ?? NaN)) < 1e-9;
      }),
    )
    .toBe(true);
  expect(result.camera[0]).toBeCloseTo(-74, 6);
});

test('controls options reach the engine: with a tilt policy the 3D button is disabled while the view is locked flat (F628)', async ({
  page,
}) => {
  const available = (): Promise<string | null> =>
    page.locator('.tilt-3d').getAttribute('data-available', { timeout: 10_000 });
  await openExample(page, 'live.html?backend=webgl2&tiltPolicy=1');
  // Zoom 5 puts the eye far beyond the policy's 20,000 m lock: no tilt, the button disabled.
  await expect.poll(available).toBe('false');
  await expect(page.locator('.tilt-3d')).toBeDisabled();
  // Close to the ground the view may tilt again.
  await set(page, { view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 14 } });
  await expect.poll(available).toBe('true');
  await expect(page.locator('.tilt-3d')).toBeEnabled();
  // Without the option the default controls have no policy: the button stays enabled at any distance.
  await openExample(page, 'live.html?backend=webgl2');
  await expect.poll(available).toBe('true');
});

test('the gltf prop gives the renderer its glTF loader: a model set loads and draws (F629)', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') warnings.push(message.text());
  });
  await openExample(page, 'live.html?backend=webgl2');
  await set(page, { view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 15 } });
  await idle(page);
  const before = await page.evaluate(() => window.adapterExample?.globes()[0]?.rendererStats().drawCalls ?? 0);
  const added = await page.evaluate(() =>
    (
      window as unknown as { adapterExampleLive: { addModels(lon: number, lat: number): Promise<string> } }
    ).adapterExampleLive.addModels(12.5, 41.9),
  );
  expect(added).toBe('ok');
  await idle(page);
  const after = await page.evaluate(() => window.adapterExample?.globes()[0]?.rendererStats().drawCalls ?? 0);
  expect(after).toBeGreaterThan(before);
  expect(warnings.filter((text) => text.includes('model'))).toEqual([]);
});
