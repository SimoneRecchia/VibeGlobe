// The Europe preset's Satellite from level 0 to 16 (F636, F633, F635): over Italy's land, its coast and the open sea,
// every source from the fixture server's `earth` patterns, which all show the playground's Natural Earth base image in
// their own tones (`scripts/fixtures/tiles/earth.ts`). With the layers fading in by zoom and matching the tones below
// them, each settled frame looks like the base image alone at the same view: no block of another color or sharpness,
// no hard edge between sources. While the zoom moves, no frame jumps from the one before, and no pixel of the globe is
// black or transparent. The frames of each step are attached to the test's report.
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { canvasImage, openGlobe, waitForIdle } from './support/globe.ts';

test.use({ viewport: { width: 320, height: 240 } });

const LAYERS = ['satellite-base', 'satellite', 'satellite-online'];
/** Over Italy's land (the fixture's online source), its coast north of Civitavecchia, and the Tyrrhenian Sea. */
const SITES = [
  { name: 'land', longitudeDeg: 12.5, latitudeDeg: 41.9 },
  { name: 'coast', longitudeDeg: 11.75, latitudeDeg: 42.15 },
  { name: 'sea', longitudeDeg: 11, latitudeDeg: 40 },
];
/** Block size of the comparisons, pixels. */
const BLOCK_PX = 8;
/**
 * The largest difference of a block's mean color from the base image alone, settled, 0–255: the sources differ from it
 * only by the fixtures' coastline drawn at their own resolution (13.7 at most, measured 2026-10-28); a source in its
 * own tone shows 25 to 35, the package's water inside its box over 100 (KB-231).
 */
const MAX_BLOCK_DIFFERENCE = 20;
/**
 * Between frames 0.1 zoom levels apart: the mean block difference is the motion itself, 4.7 to 8.1 over the base image
 * alone and through the switches alike (measured 2026-10-28); a layer appearing in a step, or a tone jumping, adds
 * its difference over a whole region.
 */
const MAX_MEAN_STEP_DIFFERENCE = 12;
const MAX_BLOCK_STEP_DIFFERENCE = 80;

/** Waits until the globe is idle with no imagery tile queued, loading, decoding or waiting for its upload. */
async function settle(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    await waitForIdle(page);
    const stats = await page.evaluate(() => window.vibeglobePlayground?.globe.imageryStats());
    if (stats && stats.queued + stats.loading + stats.decoding + stats.uploadsPending === 0) return;
  }
  throw new Error('the imagery did not settle');
}

/** Which blocks of the canvas lie on the globe (their center hits it). */
async function globeBlocks(page: Page, width: number, height: number): Promise<boolean[]> {
  return page.evaluate(
    ({ width, height, block }) => {
      const globe = window.vibeglobePlayground?.globe;
      const blocks: boolean[] = [];
      for (let y = 0; y < height; y += block)
        for (let x = 0; x < width; x += block)
          blocks.push(globe?.screenToGeo({ xPx: x + block / 2, yPx: y + block / 2 }) !== undefined);
      return blocks;
    },
    { width, height, block: BLOCK_PX },
  );
}

/** The mean color of each block. */
function blockMeans(image: PNG): Float64Array {
  const columns = Math.ceil(image.width / BLOCK_PX);
  const rows = Math.ceil(image.height / BLOCK_PX);
  const means = new Float64Array(columns * rows * 3);
  const counts = new Float64Array(columns * rows);
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const block = Math.floor(y / BLOCK_PX) * columns + Math.floor(x / BLOCK_PX);
      for (let c = 0; c < 3; c++)
        means[block * 3 + c] = (means[block * 3 + c] ?? 0) + (image.data[(y * image.width + x) * 4 + c] ?? 0);
      counts[block] = (counts[block] ?? 0) + 1;
    }
  for (let block = 0; block < counts.length; block++)
    for (let c = 0; c < 3; c++) means[block * 3 + c] = (means[block * 3 + c] ?? 0) / (counts[block] ?? 1);
  return means;
}

/** The largest difference of a block's mean color between two frames (the mean of the channels'), over the globe. */
function largestBlockDifference(a: PNG, b: PNG, onGlobe: readonly boolean[]): number {
  const ma = blockMeans(a);
  const mb = blockMeans(b);
  let largest = 0;
  onGlobe.forEach((inside, block) => {
    if (!inside) return;
    let sum = 0;
    for (let c = 0; c < 3; c++) sum += Math.abs((ma[block * 3 + c] ?? 0) - (mb[block * 3 + c] ?? 0));
    largest = Math.max(largest, sum / 3);
  });
  return largest;
}

/** The mean difference of the blocks' mean colors between two frames, over the globe. */
function meanBlockDifference(a: PNG, b: PNG, onGlobe: readonly boolean[]): number {
  const ma = blockMeans(a);
  const mb = blockMeans(b);
  let sum = 0;
  let blocks = 0;
  onGlobe.forEach((inside, block) => {
    if (!inside) return;
    for (let c = 0; c < 3; c++) sum += Math.abs((ma[block * 3 + c] ?? 0) - (mb[block * 3 + c] ?? 0)) / 3;
    blocks++;
  });
  return blocks > 0 ? sum / blocks : 0;
}

/** Pixels of the globe that are black or transparent. */
function emptyPixels(image: PNG, onGlobe: readonly boolean[]): number {
  const columns = Math.ceil(image.width / BLOCK_PX);
  let empty = 0;
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      if (!onGlobe[Math.floor(y / BLOCK_PX) * columns + Math.floor(x / BLOCK_PX)]) continue;
      const at = (y * image.width + x) * 4;
      const [r = 0, g = 0, b = 0, a = 0] = image.data.subarray(at, at + 4);
      if (a < 250 || r + g + b < 30) empty++;
    }
  return empty;
}

/** Saves a frame in the test's output folder and attaches it to its report. */
async function attach(testInfo: TestInfo, name: string, image: PNG): Promise<void> {
  const body = PNG.sync.write(image);
  writeFileSync(testInfo.outputPath(name), body);
  await testInfo.attach(name, { body, contentType: 'image/png' });
}

async function showLayers(page: Page, visible: boolean): Promise<void> {
  await page.evaluate(
    ({ ids, visible }) => {
      for (const id of ids)
        if (window.vibeglobePlayground?.globe.imageryLayers.list().some((l) => l.id === id))
          window.vibeglobePlayground.globe.imageryLayers.set(id, { visible });
    },
    { ids: LAYERS, visible },
  );
}

for (const site of SITES)
  test(`Satellite from level 0 to 16 over the ${site.name}: no block, edge, jump or hole between the sources (F636)`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(300_000);
    await openGlobe(
      page,
      `preset=europe&presetFixtures=zoom-${site.name}&presetStyle=/vector-tiles/styles/streets.json&lon=${String(site.longitudeDeg)}&lat=${String(site.latitudeDeg)}&zoom=0&embed`,
    );
    const differences: string[] = [];
    for (let zoom = 0; zoom <= 16; zoom++) {
      await page.evaluate((z) => window.vibeglobePlayground?.globe.jumpTo({ zoom: z }), zoom);
      await settle(page);
      const frame = await canvasImage(page);
      const onGlobe = await globeBlocks(page, frame.width, frame.height);
      expect(emptyPixels(frame, onGlobe), `empty pixels at zoom ${String(zoom)}`).toBe(0);
      await showLayers(page, false);
      await settle(page);
      const reference = await canvasImage(page);
      await showLayers(page, true);
      const difference = largestBlockDifference(frame, reference, onGlobe);
      differences.push(`${String(zoom)}: ${difference.toFixed(1)}`);
      expect(difference, `block difference from the base image at zoom ${String(zoom)}`).toBeLessThanOrEqual(
        MAX_BLOCK_DIFFERENCE,
      );
      console.log(
        `${site.name} zoom ${String(zoom)}: largest block difference from the base image ${difference.toFixed(1)}`,
      );
      await attach(testInfo, `${site.name}-zoom-${String(zoom)}.png`, frame);
      await attach(testInfo, `${site.name}-zoom-${String(zoom)}-base-image.png`, reference);
    }
    console.log(differences.join(', '));
    // Zooming through the switches without waiting for tiles: each frame like the one before, with no hole.
    const jumps: string[] = [];
    for (const [from, to] of [
      [3, 6],
      [10, 13],
    ] as const) {
      let previous: PNG | undefined;
      for (let zoom = from; zoom <= to + 1e-9; zoom += 0.1) {
        await page.evaluate((z) => window.vibeglobePlayground?.globe.jumpTo({ zoom: z }), zoom);
        const frame = await canvasImage(page);
        const onGlobe = await globeBlocks(page, frame.width, frame.height);
        expect(emptyPixels(frame, onGlobe), `empty pixels while zooming at ${zoom.toFixed(1)}`).toBe(0);
        if (previous) {
          const mean = meanBlockDifference(frame, previous, onGlobe);
          const largest = largestBlockDifference(frame, previous, onGlobe);
          jumps.push(`${zoom.toFixed(1)}: ${mean.toFixed(1)}/${largest.toFixed(0)}`);
          expect(mean, `mean step at zoom ${zoom.toFixed(1)}`).toBeLessThanOrEqual(MAX_MEAN_STEP_DIFFERENCE);
          expect(largest, `largest step at zoom ${zoom.toFixed(1)}`).toBeLessThanOrEqual(MAX_BLOCK_STEP_DIFFERENCE);
        }
        previous = frame;
      }
      await settle(page);
    }
    console.log('jumps', jumps.join(', '));
  });
