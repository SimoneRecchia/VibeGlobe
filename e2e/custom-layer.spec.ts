// A custom layer type from outside the engine's packages (M10, F388): `apps/custom-layer-example` implements beacons
// against the public layer interface only; in the playground they draw at their coordinates, receive frame and camera
// events, and picking and clicks return them, on both backends.
import { expect, test } from '@playwright/test';
import { canvasImage, openGlobe, waitForIdle } from './support/globe.ts';

test.use({ viewport: { width: 480, height: 360 } });

const BACKENDS = ['webgpu', 'webgl2'] as const;

/** The beacons of `?scenario=data-custom`. */
const BEACONS = [
  ['north', 12.5, 42.2],
  ['south', 12.3, 41.6],
  ['east', 13.0, 41.9],
] as const;

interface CustomHandle {
  frames: number;
  lastZoom: number;
  on(type: 'click', handler: (event: { feature: { id: string | number } }) => void): () => void;
}

for (const backend of BACKENDS) {
  test(`a custom layer from outside the engine draws at its coordinates, receives frames and camera changes, and is picked and clicked on ${backend} (F388)`, async ({
    page,
  }) => {
    await openGlobe(page, `backend=${backend}&scenario=data-custom&viewMode=2d&lon=12.6&lat=41.9&zoom=8`);
    await page.waitForFunction(() => window.vibeglobeLayers !== undefined);
    await page.evaluate(() =>
      document.querySelector<HTMLElement>('#camera-controls')?.style.setProperty('display', 'none'),
    );
    await waitForIdle(page);
    const image = await canvasImage(page);
    for (const [id, lon, lat] of BEACONS) {
      const at = await page.evaluate(
        ([longitudeDeg, latitudeDeg]) => window.vibeglobePlayground?.globe.geoToScreen({ longitudeDeg, latitudeDeg }),
        [lon, lat] as const,
      );
      if (!at) throw new Error(`${id} off screen`);
      const i = (Math.round(at.yPx) * image.width + Math.round(at.xPx)) * 4;
      const [r, g, b] = [image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0];
      expect(r > 200 && b > 200 && g < 80, `${id} drawn magenta at its coordinate: ${r}, ${g}, ${b}`).toBe(true);
      // Picking returns the beacon.
      const picked = await page.evaluate(async (point) => {
        const globe = window.vibeglobePlayground?.globe;
        const hit = window.vibeglobeLayers?.stack.resolvePick((await globe?.layerTarget()?.pick?.(point)) ?? 0);
        return hit ? `${hit.feature.layerId}/${String(hit.feature.id)}` : 'nothing';
      }, at);
      expect(picked).toBe(`beacons/${id}`);
    }
    // A click on a beacon reaches the layer's handlers through the stack's interaction.
    const at = await page.evaluate(() =>
      window.vibeglobePlayground?.globe.geoToScreen({ longitudeDeg: 13.0, latitudeDeg: 41.9 }),
    );
    if (!at) throw new Error('east off screen');
    const clicked = page.evaluate(
      () =>
        new Promise<string>((resolve) =>
          (window.vibeglobeLayers as unknown as { custom: CustomHandle }).custom.on('click', ({ feature }) =>
            resolve(String(feature.id)),
          ),
        ),
    );
    const box = await page.locator('#globe').boundingBox();
    await page.mouse.click((box?.x ?? 0) + at.xPx, (box?.y ?? 0) + at.yPx);
    expect(await clicked).toBe('east');
    // Frame and camera events: the layer saw frames, and a zoom change reaches it.
    const custom = () =>
      page.evaluate(() => {
        const layer = (window.vibeglobeLayers as unknown as { custom: CustomHandle }).custom;
        return { frames: layer.frames, zoom: layer.lastZoom };
      });
    const before = await custom();
    expect(before.frames).toBeGreaterThan(0);
    expect(before.zoom).toBeCloseTo(8, 3);
    await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ zoom: 9.5 }));
    await waitForIdle(page);
    const after = await custom();
    expect(after.frames).toBeGreaterThan(before.frames);
    expect(after.zoom).toBeCloseTo(9.5, 3);
  });
}
