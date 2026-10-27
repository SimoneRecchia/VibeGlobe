// WMTS and WMS sources on the globe on both backends (F230, F231): WMTS tiles land at their place with RESTful and KVP
// requests alike, and WMS labels that cross tile edges are drawn whole thanks to the gutter, with no seam.
import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Route } from '@playwright/test';
import { PNG } from 'pngjs';
import {
  expectCenterTileColor,
  expectNoEmptyPixels,
  mountSource,
  openSources,
  settledSourceFrame,
  tilePng,
} from './support/sources.ts';

const CORS = { 'Access-Control-Allow-Origin': '*' };
const H = 20037508.342789244;
const OGC_SAMPLE = readFileSync('packages/sources/src/__fixtures__/capabilities/wmts-ogc-sample.xml', 'utf8');

function png(route: Route, bytes: Uint8Array): Promise<void> {
  return route.fulfill({ status: 200, headers: { ...CORS, 'Content-Type': 'image/png' }, body: Buffer.from(bytes) });
}

/** The recorded OGC sample's RESTful and KVP tile endpoints, answering with the fixture pyramid's tiles. */
async function serveWmts(page: Page): Promise<void> {
  await page.route('http://www.example.com/wmts/coastlines/**', (route) => {
    const [z = 0, row = 0, col = 0] =
      /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(route.request().url())?.slice(1).map(Number) ?? [];
    return png(route, tilePng(z, col, row));
  });
  await page.route('http://www.maps.bob/cgi-bin/**', (route) => {
    const params = new URL(route.request().url()).searchParams;
    const value = (name: string): number => Number(params.get(name));
    return png(route, tilePng(value('TILEMATRIX'), value('TILECOL'), value('TILEROW')));
  });
}

const LABEL_RGB = [20, 20, 110] as const;
const LABEL_HALF_PX = [30, 12] as const;
/** Label anchors exactly on tile edges of every level from 5 on: a column edge and a row edge. */
const ANCHORS = [
  { longitudeDeg: 11.25, latitudeDeg: 42.3 },
  { longitudeDeg: 13.6, latitudeDeg: (Math.atan(Math.sinh(Math.PI * (1 - 24 / 32))) * 180) / Math.PI },
];

function background(lonDeg: number, latDeg: number): [number, number, number] {
  return [128 + 90 * Math.sin((lonDeg * Math.PI) / 12), 128 + 90 * Math.sin((latDeg * Math.PI) / 12), 160];
}

/**
 * A map server rendering a smooth background with label boxes. Like real servers it draws a label only when its
 * anchor lies inside the requested box (half-open), so without a gutter a label on a tile edge is cut.
 */
function renderGetMap(url: string): Uint8Array {
  const params = new URL(url).searchParams;
  const [minx = 0, miny = 0, maxx = 0, maxy = 0] = (params.get('BBOX') ?? '').split(',').map(Number);
  const width = Number(params.get('WIDTH'));
  const height = Number(params.get('HEIGHT'));
  const image = new PNG({ width, height });
  for (let j = 0; j < height; j++) {
    const my = maxy - ((j + 0.5) / height) * (maxy - miny);
    const lat = (Math.atan(Math.sinh((my / H) * Math.PI)) * 180) / Math.PI;
    for (let i = 0; i < width; i++) {
      const lon = ((minx + ((i + 0.5) / width) * (maxx - minx)) / H) * 180;
      const [r, g, b] = background(lon, lat);
      image.data.set([r, g, b, 255], (j * width + i) * 4);
    }
  }
  for (const anchor of ANCHORS) {
    const ax = (anchor.longitudeDeg / 180) * H;
    const ay = (H * Math.log(Math.tan(Math.PI / 4 + (anchor.latitudeDeg * Math.PI) / 360))) / Math.PI;
    if (ax < minx || ax >= maxx || ay <= miny || ay > maxy) continue;
    const ci = ((ax - minx) / (maxx - minx)) * width;
    const cj = ((maxy - ay) / (maxy - miny)) * height;
    for (
      let j = Math.max(0, Math.round(cj - LABEL_HALF_PX[1]));
      j < Math.min(height, Math.round(cj + LABEL_HALF_PX[1]));
      j++
    )
      for (
        let i = Math.max(0, Math.round(ci - LABEL_HALF_PX[0]));
        i < Math.min(width, Math.round(ci + LABEL_HALF_PX[0]));
        i++
      )
        image.data.set([...LABEL_RGB, 255], (j * width + i) * 4);
  }
  return new Uint8Array(PNG.sync.write(image));
}

/** How many sample points around each anchor show the label color; 9 per anchor when the label is whole. */
async function labelSamples(page: Page, frame: PNG): Promise<number[]> {
  const points = await page.evaluate(
    (anchors) => anchors.map((a) => window.vibeglobeSources?.globe?.geoToScreen(a)),
    ANCHORS,
  );
  const ratio =
    frame.width / (await page.evaluate(() => document.querySelector('.vg-source-test canvas')?.clientWidth ?? 1));
  return points.map((p) => {
    if (!p) return -1;
    let hits = 0;
    for (const dx of [-14, 0, 14])
      for (const dy of [-5, 0, 5]) {
        const i = (Math.round((p.yPx + dy) * ratio) * frame.width + Math.round((p.xPx + dx) * ratio)) * 4;
        const close = LABEL_RGB.every((v, c) => Math.abs((frame.data[i + c] ?? 0) - v) <= 30);
        if (close) hits++;
      }
    return hits;
  });
}

/** The largest color step between neighboring pixels along a row away from the labels. */
function largestStep(frame: PNG): number {
  const y = Math.floor(frame.height * 0.2);
  let largest = 0;
  for (let x = 1; x < frame.width; x++)
    for (let c = 0; c < 3; c++) {
      const a = frame.data[(y * frame.width + x - 1) * 4 + c] ?? 0;
      const b = frame.data[(y * frame.width + x) * 4 + c] ?? 0;
      largest = Math.max(largest, Math.abs(a - b));
    }
  return largest;
}

for (const backend of ['webgpu', 'webgl2'] as const) {
  test.describe(`OGC adapters on ${backend}`, () => {
    // Two globes are mounted and settled one after the other on the container's software GPU.
    test.setTimeout(240_000);

    test(`WMTS tiles land at their place with RESTful and KVP requests (F230)`, async ({ page }) => {
      await serveWmts(page);
      await openSources(page, `backend=${backend}&lon=12.5&lat=41.9&zoom=2.6`);
      const layer = { layer: 'BlueMarbleNextGeneration', tileMatrixSet: 'google3857' };
      await mountSource(page, `(s, o) => s.wmtsImagery({ id: 'rest', ...o })`, { ...layer, capabilities: OGC_SAMPLE });
      const rest = await settledSourceFrame(page, 18);
      await expectCenterTileColor(page, rest);
      await expectNoEmptyPixels(page, rest);
      await mountSource(page, `(s, o) => s.wmtsImagery({ id: 'kvp', encoding: 'KVP', ...o })`, {
        ...layer,
        capabilities: OGC_SAMPLE,
      });
      const kvp = await settledSourceFrame(page, 18);
      expect(Buffer.compare(rest.data, kvp.data)).toBe(0);
    });

    test(`WMS labels crossing tile edges are whole and tiles join without seams (F231)`, async ({ page }) => {
      await page.route('https://wms.test/map**', (route) => png(route, renderGetMap(route.request().url())));
      await openSources(page, `backend=${backend}&lon=12.4&lat=41.6&zoom=5.5`);
      // The fixture server draws an opaque background: the source says so (WMS sources are transparent by default,
      // KB-154), and draws as the base.
      const source = `(s, gutter) => s.wmsImagery({ id: 'labels-' + gutter, url: 'https://wms.test/map', layers: ['labels'], gutterPx: gutter, transparent: false })`;
      await mountSource(page, source, 32);
      const whole = await settledSourceFrame(page, 20);
      await expectNoEmptyPixels(page, whole);
      expect(await labelSamples(page, whole)).toEqual([9, 9]);
      expect(largestStep(whole)).toBeLessThan(16);
      // The control: without a gutter the same labels are cut at the tile edges.
      await mountSource(page, source, 0);
      const cut = await settledSourceFrame(page, 20);
      expect((await labelSamples(page, cut)).every((hits) => hits < 9)).toBe(true);
    });
  });
}
