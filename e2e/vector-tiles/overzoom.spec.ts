// F442: beyond the fixture tileset's maxzoom (14) the deepest tiles are overzoomed, a parent tile stands in until its
// children are ready on a slow link, and tiles out of the source's coverage are never requested.
import { expect, test, type Page } from '@playwright/test';
import { capture, countArea, countColor, hex, openVector, settle } from './support.ts';

test.use({ viewport: { width: 320, height: 240 } });

/** The style's background (water): it shows only where no vector tile covers the land. */
const BACKGROUND = hex('#a8cfe0');

const CITY = { longitudeDeg: 9.19, latitudeDeg: 45.465 };

const zooms = (page: Page) =>
  page.evaluate(() =>
    (window.vibeglobeVectorTiles?.layer?.requestLog() ?? []).map((url) => Number(/tiles\/(\d+)\//.exec(url)?.[1])),
  );

async function jump(page: Page, zoom: number): Promise<void> {
  await page.evaluate((view) => window.vibeglobePlayground?.globe.jumpTo(view), { ...CITY, zoom });
}

test('tiles past maxzoom are overzoomed: content stays drawn and nothing deeper is requested (F442)', async ({
  page,
}) => {
  await openVector(page, 'scenario=mvt-flat&backend=webgl2');
  await jump(page, 19);
  await settle(page);
  expect(Math.max(...(await zooms(page)))).toBe(14);
  const drawn = await page.evaluate(() => window.vibeglobeVectorTiles?.layer?.drawnTiles() ?? []);
  expect(drawn.length).toBeGreaterThan(0);
  // Every target deeper than 14 is drawn from a zoom-14 tile.
  const deep = drawn.filter((d) => Number(d.target.split('/')[0]) > 14);
  expect(deep.length).toBeGreaterThan(0);
  expect(deep.every((d) => d.tile.startsWith('14/'))).toBe(true);
  // The land is drawn everywhere (no background), and the city's road crosses the view.
  const image = await capture(page);
  expect(countArea(image, BACKGROUND, 6)).toBe(0);
  expect(countColor(image, hex('#fcd6a4'), 10)).toBeGreaterThan(100);
});

test('on a slow link a parent stands in while its children load: no frame shows a hole (F442)', async ({ page }) => {
  // Every tile takes 400 ms more; the view zooms faster than tiles arrive.
  await page.route('**/vector-tiles/tiles/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });
  await openVector(page, 'scenario=mvt-flat&backend=webgl2&zoom=10&lon=9.19&lat=45.465');
  let standIns = 0;
  for (let zoom = 10; zoom <= 16; zoom += 0.5) {
    await jump(page, zoom);
    const image = await capture(page);
    expect(countArea(image, BACKGROUND, 6), `zoom ${zoom}`).toBe(0);
    standIns += await page.evaluate(
      () => window.vibeglobeVectorTiles?.layer?.drawnTiles().filter((d) => d.standIn).length ?? 0,
    );
  }
  // The link was slow enough that stand-ins were drawn.
  expect(standIns).toBeGreaterThan(0);
});

test('tiles out of the source coverage are never requested (F442)', async ({ page }) => {
  await openVector(page, 'vectorStyle=streets-bounded&backend=webgl2&zoom=12&lon=9.19&lat=45.465');
  // Pan far out of the bounds, then back.
  for (const view of [
    { longitudeDeg: 2.35, latitudeDeg: 48.86, zoom: 12 },
    { longitudeDeg: 9.4, latitudeDeg: 45.465, zoom: 13 },
    { ...CITY, zoom: 18 },
  ]) {
    await page.evaluate((v) => window.vibeglobePlayground?.globe.jumpTo(v), view);
    await settle(page);
  }
  const urls = await page.evaluate(() => window.vibeglobeVectorTiles?.layer?.requestLog() ?? []);
  expect(urls.length).toBeGreaterThan(0);
  const [west, south, east, north] = [9.1, 45.4, 9.3, 45.5];
  const lonX = (lon: number, n: number) => ((lon + 180) / 360) * n;
  const latY = (lat: number, n: number) => {
    const s = Math.sin((lat * Math.PI) / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  };
  for (const url of urls) {
    const [z, x, y] = (/tiles\/(\d+)\/(\d+)\/(\d+)/.exec(url) ?? []).slice(1).map(Number) as [number, number, number];
    const n = 2 ** z;
    expect(z, url).toBeLessThanOrEqual(14);
    expect(x + 1 > lonX(west, n) && x < lonX(east, n) && y + 1 > latY(north, n) && y < latY(south, n), url).toBe(true);
  }
});
