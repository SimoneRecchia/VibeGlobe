// Dragging features (M10, F382): draggable points, markers and glTF models follow the mouse and a finger, with drag
// start, move and end events; the map does not pan meanwhile; a ground-clamped point stays on the terrain; a feature
// whose layer is not draggable is not dragged.
import { expect, test, type Page } from '@playwright/test';
import { canvasImage, openGlobe, waitForIdle } from './support/globe.ts';
import { Touch } from './support/controls.ts';

test.use({ viewport: { width: 480, height: 360 }, hasTouch: true });

const BACKENDS = ['webgpu', 'webgl2'] as const;

/** The features of `?scenario=data-drag` (`apps/playground/src/layers-select.ts`). */
const DRAGGABLE = [
  { layer: 'drag-point', id: 'dp', at: [6.7, 45.85] },
  { layer: 'drag-marker', id: 'dm', at: [7.0, 45.85] },
  { layer: 'drag-model', id: 'dg', at: [6.7, 45.7] },
] as const;

/** Where a feature's anchor shows, on the terrain under it. */
function anchor(page: Page, layer: string, id: string) {
  return page.evaluate(
    ({ layer, id }) => {
      const globe = window.vibeglobePlayground?.globe;
      const target =
        window.vibeglobeLayers?.layers[layer] ?? (window.vibeglobeLayers as { models?: unknown } | undefined)?.models;
      const position = (
        target as { getPosition(id: string): { longitudeDeg: number; latitudeDeg: number; heightMeters?: number } }
      ).getPosition(id);
      if (!globe || !position) throw new Error(`no ${layer}/${id}`);
      const ground = globe.elevationAt(position).heightMeters;
      // Points and markers stand on the ground; the model is placed at its absolute height.
      const height = layer === 'drag-model' ? (position.heightMeters ?? 0) : ground;
      return { position, ground, screen: globe.geoToScreen({ ...position, heightMeters: height }) };
    },
    { layer, id },
  );
}

async function recordEvents(page: Page): Promise<void> {
  await page.evaluate(() => {
    const log: string[] = [];
    (window as unknown as { dragLog: string[] }).dragLog = log;
    const layers = window.vibeglobeLayers;
    if (!layers) throw new Error('no layers');
    const all = [...Object.values(layers.layers), (layers as { models?: unknown }).models].filter(Boolean) as {
      id: string;
      on(
        type: string,
        handler: (event: { feature: { id: unknown }; position?: { longitudeDeg: number } }) => void,
      ): void;
    }[];
    for (const layer of all)
      for (const type of ['drag-start', 'drag', 'drag-end'])
        layer.on(type, (event) =>
          log.push(`${type}:${String(event.feature.id)}:${event.position?.longitudeDeg ?? '-'}`),
        );
  });
}

const center = (page: Page) =>
  page.evaluate(() => {
    const camera = window.vibeglobePlayground?.globe.camera;
    return [camera?.longitudeDeg ?? 0, camera?.latitudeDeg ?? 0];
  });

for (const backend of BACKENDS) {
  test(`draggable points, markers and models follow the mouse and a finger without panning the map, a clamped point stays on the terrain, and other features are not dragged on ${backend} (F382)`, async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await openGlobe(page, `backend=${backend}&terrain=terrarium&scenario=data-drag&lon=6.85&lat=45.78&zoom=9&tilt=40`);
    await page.waitForFunction(
      () => (window.vibeglobeLayers as { models?: unknown } | undefined)?.models !== undefined,
    );
    await waitForIdle(page);
    await recordEvents(page);
    const box = await page.locator('#globe').boundingBox();
    if (!box) throw new Error('no canvas');
    const touch = await Touch.create(page);
    for (const { layer, id } of DRAGGABLE) {
      for (const input of ['mouse', 'touch'] as const) {
        const before = await center(page);
        const start = await anchor(page, layer, id);
        if (!start.screen) throw new Error(`${id} off screen`);
        const from = start.screen;
        const to = { xPx: from.xPx + 40, yPx: from.yPx + (input === 'mouse' ? 25 : -25) };
        await page.evaluate(() => ((window as unknown as { dragLog: string[] }).dragLog.length = 0));
        if (input === 'mouse') {
          await page.mouse.move(box.x + from.xPx, box.y + from.yPx);
          await page.mouse.down();
          await page.waitForTimeout(200);
          await page.mouse.move(box.x + to.xPx, box.y + to.yPx, { steps: 8 });
          await page.mouse.up();
        } else {
          await touch.start([{ id: 1, x: from.xPx, y: from.yPx }]);
          await page.waitForTimeout(200);
          for (let i = 1; i <= 8; i++)
            await touch.move([
              { id: 1, x: from.xPx + ((to.xPx - from.xPx) * i) / 8, y: from.yPx + ((to.yPx - from.yPx) * i) / 8 },
            ]);
          await touch.end();
        }
        await page.waitForTimeout(300);
        await waitForIdle(page);
        const log = await page.evaluate(() => (window as unknown as { dragLog: string[] }).dragLog);
        expect(log[0], `${id} by ${input}`).toMatch(new RegExp(`^drag-start:${id}:`));
        expect(log.at(-1), `${id} by ${input}`).toMatch(new RegExp(`^drag-end:${id}:`));
        expect(log.filter((entry) => entry.startsWith(`drag:${id}:`)).length).toBeGreaterThan(2);
        // The map did not pan.
        expect(await center(page)).toEqual(before);
        // The feature is where the pointer let go, on the terrain there.
        const end = await anchor(page, layer, id);
        expect(
          Math.hypot((end.screen?.xPx ?? 0) - to.xPx, (end.screen?.yPx ?? 0) - to.yPx),
          `${id} by ${input}`,
        ).toBeLessThan(3);
      }
    }
    // The clamped point is drawn on the terrain where it now is, high on the fixture's flank.
    const point = await anchor(page, 'drag-point', 'dp');
    const onEllipsoid = await page.evaluate(
      (position) => window.vibeglobePlayground?.globe.geoToScreen({ ...position, heightMeters: 0 }),
      point.position,
    );
    const at = point.screen ?? { xPx: 0, yPx: 0 };
    // In the tilted view the terrain's height moves it visibly from where it would show on the ellipsoid.
    expect(Math.hypot(at.xPx - (onEllipsoid?.xPx ?? 0), at.yPx - (onEllipsoid?.yPx ?? 0))).toBeGreaterThan(5);
    const image = await canvasImage(page);
    let red = 0;
    for (let y = Math.round(at.yPx) - 3; y <= Math.round(at.yPx) + 3; y++)
      for (let x = Math.round(at.xPx) - 3; x <= Math.round(at.xPx) + 3; x++) {
        const i = (y * image.width + x) * 4;
        if ((image.data[i] ?? 0) > 200 && (image.data[i + 1] ?? 0) < 80 && (image.data[i + 2] ?? 0) < 80) red++;
      }
    expect(red).toBeGreaterThan(10);
    // A feature of a layer that is not draggable: the press pans the map instead, and no drag event fires.
    await page.evaluate(() => ((window as unknown as { dragLog: string[] }).dragLog.length = 0));
    const fixed = await anchor(page, 'fixed-point', 'fx');
    const before = await center(page);
    const from = fixed.screen ?? { xPx: 0, yPx: 0 };
    await page.mouse.move(box.x + from.xPx, box.y + from.yPx);
    await page.mouse.down();
    await page.mouse.move(box.x + from.xPx + 40, box.y + from.yPx + 25, { steps: 8 });
    await page.mouse.up();
    await waitForIdle(page);
    expect(await page.evaluate(() => (window as unknown as { dragLog: string[] }).dragLog)).toEqual([]);
    expect(await center(page)).not.toEqual(before);
    expect((await anchor(page, 'fixed-point', 'fx')).position).toEqual(fixed.position);
  });
}
