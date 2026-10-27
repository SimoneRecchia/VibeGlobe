// F459: hovering and clicking a road, a place label and an extruded building of the vector tiles returns the feature's
// layer, properties and position in the event, and highlights it (the fixture style colors `selected` features
// #ff3b30), on both backends and with touch.
import { expect, test, type Page } from '@playwright/test';
import { BACKENDS, capture, hex, near, openVector, rgbAt } from './support.ts';

test.use({ viewport: { width: 640, height: 480 } });

const SELECTED = hex('#ff3b30');

interface Recorded {
  type: string;
  layerId: string;
  properties: Record<string, unknown>;
  position: { longitudeDeg: number; latitudeDeg: number };
}

async function record(page: Page): Promise<void> {
  await page.evaluate(() => {
    const events: unknown[] = [];
    (window as unknown as { vtEvents: unknown[] }).vtEvents = events;
    window.vibeglobeVectorTiles?.layer?.on((e) =>
      events.push({
        type: e.type,
        layerId: e.feature.layerId,
        properties: e.feature.properties,
        position: e.feature.position,
      }),
    );
  });
}

const events = (page: Page) => page.evaluate(() => (window as unknown as { vtEvents: Recorded[] }).vtEvents.splice(0));

async function screenOf(page: Page, longitudeDeg: number, latitudeDeg: number): Promise<{ x: number; y: number }> {
  const p = await page.evaluate((g) => window.vibeglobePlayground?.globe.geoToScreen(g), { longitudeDeg, latitudeDeg });
  if (p === undefined) throw new Error('off screen');
  const box = await page.locator('#app').boundingBox();
  return { x: (box?.x ?? 0) + p.xPx, y: (box?.y ?? 0) + p.yPx };
}

async function labelCenter(page: Page, text: string): Promise<{ x: number; y: number }> {
  const box = await page.evaluate(
    (t) => window.vibeglobeVectorTiles?.layer?.placedLabels().find((l) => l.text === t)?.boxes[0],
    text,
  );
  if (box === undefined) throw new Error(`label ${text} not placed`);
  return { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
}

/** The targets: a road, a place label and a building of the fixture city. */
async function targets(page: Page) {
  return {
    road: await screenOf(page, 9.187, 45.465),
    label: await labelCenter(page, 'Milan'),
    building: await screenOf(page, 9.1895, 45.4642),
  };
}

for (const backend of BACKENDS) {
  test(`hover and click events carry the feature and highlight it (${backend}, F459)`, async ({ page }) => {
    // The vector scene, three pointer rounds and two captures took 25 s on CI's software GPU, where a pointer move
    // waits for the page to acknowledge it after its long frames: close to the default 30 s, which it crossed once.
    test.setTimeout(60_000);
    await openVector(page, `scenario=mvt-labels&backend=${backend}`);
    await record(page);
    const t = await targets(page);
    const expected = {
      road: { layerId: 'road', name: 'Corso Buenos Aires' },
      label: { layerId: 'place-label', name: 'Milano' },
      building: { layerId: 'building', name: undefined },
    } as const;
    for (const key of ['road', 'building', 'label'] as const) {
      const at = t[key];
      await events(page);
      await page.mouse.move(at.x, at.y);
      await page.mouse.click(at.x, at.y);
      const got = await events(page);
      const hover = got.find((e) => e.type === 'hover');
      const click = got.find((e) => e.type === 'click');
      expect(hover?.layerId, key).toBe(expected[key].layerId);
      expect(click?.layerId, key).toBe(expected[key].layerId);
      if (expected[key].name !== undefined) expect(click?.properties['name']).toBe(expected[key].name);
      expect(click?.position.longitudeDeg).toBeCloseTo(key === 'label' ? 9.19 : key === 'road' ? 9.187 : 9.1895, 2);
      expect(click?.position.latitudeDeg).toBeCloseTo(key === 'label' ? 45.464 : key === 'road' ? 45.465 : 45.4642, 2);
      if (key === 'label') continue;
      // The selection highlight shows on the picked feature in the next frame.
      await page.mouse.move(5, 5);
      const image = await capture(page);
      expect(near(rgbAt(image, at.x, at.y), SELECTED, 24), `${key} highlighted`).toBe(true);
    }
  });
}

test.describe('touch', () => {
  test.use({ hasTouch: true });

  test('a tap picks and highlights a building (F459)', async ({ page }) => {
    await openVector(page, 'scenario=mvt-labels&backend=webgl2');
    await record(page);
    const { building } = await targets(page);
    await page.touchscreen.tap(building.x, building.y);
    const click = (await events(page)).find((e) => e.type === 'click');
    expect(click?.layerId).toBe('building');
    await page.waitForTimeout(500);
    expect(click?.properties['building']).toBeDefined();
    const image = await capture(page);
    expect(near(rgbAt(image, building.x, building.y), SELECTED, 24)).toBe(true);
  });
});
