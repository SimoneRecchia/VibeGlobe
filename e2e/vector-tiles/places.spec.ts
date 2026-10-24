// F454: place labels ranked by importance and decluttered at every zoom from the globe to the street, in the configured
// language with a fallback to `name`, and without flicker while zooming.
import { expect, test, type Page } from '@playwright/test';
import { capture, openVector, settle } from './support.ts';

test.use({ viewport: { width: 400, height: 300 } });

const MILAN = { longitudeDeg: 9.19, latitudeDeg: 45.464 };

interface Placed {
  id: number;
  layerId: string;
  text: string;
  boxes: { minX: number; minY: number; maxX: number; maxY: number }[];
  opacity: number;
}

const places = async (page: Page): Promise<Placed[]> =>
  ((await page.evaluate(() => window.vibeglobeVectorTiles?.layer?.placedLabels() ?? [])) as unknown as Placed[]).filter(
    (l) => l.layerId === 'place-label',
  );

test('places are ranked and decluttered from the globe to the street (F454)', async ({ page }) => {
  test.setTimeout(180_000);
  await openVector(page, 'scenario=mvt-globe-zoom&backend=webgl2&zoom=2&lon=9.19&lat=45.464');
  const firstZoom = new Map<string, number>();
  for (const zoom of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
    await page.evaluate((v) => window.vibeglobePlayground?.globe.jumpTo(v), { ...MILAN, zoom });
    await settle(page);
    const labels = await places(page);
    for (const l of labels) if (!firstZoom.has(l.text)) firstZoom.set(l.text, zoom);
    // Never two place labels over each other.
    for (const [i, a] of labels.entries())
      for (const b of labels.slice(i + 1))
        for (const ba of a.boxes)
          for (const bb of b.boxes)
            expect(
              ba.minX < bb.maxX && bb.minX < ba.maxX && ba.minY < bb.maxY && bb.minY < ba.maxY,
              `${a.text} / ${b.text} at zoom ${zoom}`,
            ).toBe(false);
  }
  const at = (name: string) => firstZoom.get(name) ?? Infinity;
  // Countries and the capital first, then the city, then towns, then neighbourhoods.
  expect(at('Italy')).toBeLessThanOrEqual(at('Milan'));
  expect(at('Rome')).toBeLessThanOrEqual(at('Milan'));
  expect(at('Milan')).toBeLessThan(at('Monza'));
  expect(at('Monza')).toBeLessThan(at('Brera'));
  expect(at('Brera')).toBeLessThan(Infinity);
});

test('place names follow the configured language, with a fallback to name (F454)', async ({ page }) => {
  await openVector(page, 'scenario=mvt-globe-zoom&backend=webgl2&zoom=6&lon=10.5&lat=44.5');
  const texts = async () => (await places(page)).map((l) => l.text);
  expect(await texts()).toContain('Milan');
  await page.evaluate(() => window.vibeglobeVectorTiles?.layer?.setLanguage('it'));
  await expect.poll(texts, { timeout: 10_000 }).toContain('Milano');
  const italian = await texts();
  expect(italian).not.toContain('Milan');
  // Bologna has no Italian name tag: its name is the fallback.
  expect(italian).toContain('Bologna');
  await page.evaluate(() => window.vibeglobeVectorTiles?.layer?.setLanguage('en'));
  await expect.poll(texts, { timeout: 10_000 }).toContain('Milan');
});

test('place labels do not flicker during a zoom (F454)', async ({ page }) => {
  test.setTimeout(180_000);
  await openVector(page, 'scenario=mvt-globe-zoom&backend=webgl2&zoom=5&lon=9.19&lat=45.464');
  const history = new Map<number, boolean[]>();
  const frames = 40;
  for (let k = 0; k < frames; k++) {
    await page.evaluate((v) => window.vibeglobePlayground?.globe.jumpTo(v), { ...MILAN, zoom: 5 + k * 0.08 });
    await capture(page);
    const shown = new Set((await places(page)).filter((l) => l.opacity > 0).map((l) => l.id));
    for (const id of new Set([...history.keys(), ...shown])) {
      const list = history.get(id) ?? Array<boolean>(k).fill(false);
      list.push(shown.has(id));
      history.set(id, list);
    }
  }
  let flickers = 0;
  for (const list of history.values())
    for (let i = 1; i < list.length; i++)
      if (!list[i] && list[i - 1] && list.slice(i, i + 10).some(Boolean)) flickers++;
  expect(flickers).toBe(0);
});
