import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, nextFrame, openGlobe } from './support/globe.js';
import { fixtureSession, waitForImagery } from './support/imagery.js';
import { compareImages, CROSS_BACKEND } from './support/visual.js';

/** F104: KTX2 imagery uploads in a compressed format where the device has one, and transcodes to RGBA8 elsewhere. */

// Seven pages each stream 126 tiles to full detail; on the software GPU of CI that takes 3–5 minutes (docs/test-changes.md).
test.describe.configure({ timeout: 360_000 });

/** A view whose every tile is a Mercator tile of level 3: 256 px tiles with a full chain of 9 levels. */
const VIEW = 'lon=12.5&lat=41.9&zoom=3.2';
/** GPU bytes of one 256 px tile with its chain (ADR 0020 rule 6). */
const RGBA8_TILE = 349_524;
const EIGHT_BYTE_BLOCKS_TILE = 43_704;
const SIXTEEN_BYTE_BLOCKS_TILE = 87_408;

interface Loaded {
  image: PNG;
  ready: number;
  gpuBytes: number;
  compressed: number;
  transcoderFetched: boolean;
  uploadMs: number[];
}

/** Opens the fixture imagery with `query`, waits until every tile shows its own level and reads what was loaded. */
async function load(page: Page, backend: string, query: string): Promise<Loaded> {
  let transcoderFetched = false;
  page.on('request', (request) => {
    if (request.url().includes('vibeglobe-basis')) transcoderFetched = true;
  });
  const session = await fixtureSession(page);
  await openGlobe(page, `backend=${backend}&imagery=levels&session=${session}&${VIEW}&${query}`);
  const uploadMs: number[] = [];
  await page.exposeFunction('recordUploadMs', (ms: number) => uploadMs.push(ms));
  // The upload time per tile of every frame that uploaded.
  await page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    let uploads = 0;
    globe?.on('frame', () => {
      const stats = globe.imageryStats();
      const count = (stats?.uploads ?? 0) - uploads;
      uploads = stats?.uploads ?? 0;
      if (count > 0 && stats)
        void (window as unknown as { recordUploadMs: (ms: number) => void }).recordUploadMs(
          stats.uploadMsLastFrame / count,
        );
    });
  });
  await nextFrame(page);
  await waitForImagery(page);
  const stats = await page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    return { imagery: globe?.imageryStats(), renderer: globe?.rendererStats() };
  });
  expect(stats.imagery?.failed).toBe(0);
  return {
    image: await canvasImage(page),
    ready: stats.imagery?.ready ?? 0,
    gpuBytes: stats.imagery?.gpuBytes ?? 0,
    compressed: stats.renderer?.compressedTextures ?? 0,
    transcoderFetched,
    uploadMs,
  };
}

/** Peak signal-to-noise ratio of two captures' RGB channels, in dB. */
function psnr(a: PNG, b: PNG): number {
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 4)
    for (let c = 0; c < 3; c++) sum += ((a.data[i + c] ?? 0) - (b.data[i + c] ?? 0)) ** 2;
  return 10 * Math.log10((255 * 255) / (sum / ((a.data.length / 4) * 3)));
}

const median = (values: number[]): number => [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)] ?? 0;

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(`KTX2 tiles render in every target like the PNG source, compressed tiles taking 4–8 times less GPU memory, on ${backend} (F104)`, async ({
    browser,
  }) => {
    const run = async (query: string): Promise<Loaded> => {
      const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
      try {
        return await load(page, backend, query);
      } finally {
        await page.close();
      }
    };
    const png = await run('');
    // An app without KTX2 sources never downloads the transcoder (ADR 0020 rule 4).
    expect(png.transcoderFetched).toBe(false);
    expect(png.compressed).toBe(0);
    expect(png.gpuBytes).toBe(png.ready * RGBA8_TILE);
    // Each mode's RGBA8 transcode, the fallback of devices without a compressed family (GPU mipmaps), measures the
    // codec against the source; every compressed target of the same files must then render like it (ADR 0012).
    const reference = { etc1s: await run('ktx2=etc1s&compressed='), uastc: await run('ktx2=uastc&compressed=') };
    for (const mode of ['etc1s', 'uastc'] as const) {
      const rgba8 = reference[mode];
      expect(rgba8.transcoderFetched).toBe(true);
      // Each page counts its own tiles: how many tiles a page loaded on the way to the view varies with timing.
      expect(rgba8.ready).toBeGreaterThan(0);
      expect(rgba8.gpuBytes).toBe(rgba8.ready * RGBA8_TILE);
      expect(rgba8.compressed).toBe(0);
      // ETC1S is the lossier mode (ADR 0020, survey §5); UASTC renders like the source within ADR 0012.
      const quality = psnr(png.image, rgba8.image);
      console.log(`${backend} ${mode} to RGBA8: PSNR ${quality.toFixed(1)} dB against the PNG source`);
      expect(quality).toBeGreaterThan(mode === 'etc1s' ? 30 : 40);
      if (mode === 'uastc')
        expect(compareImages(png.image, rgba8.image, CROSS_BACKEND.threshold).ratio).toBeLessThanOrEqual(
          CROSS_BACKEND.maxDiffRatio,
        );
    }
    const cases = [
      { mode: 'etc1s', families: 'bc', tileBytes: EIGHT_BYTE_BLOCKS_TILE, label: 'ETC1S to BC1' },
      { mode: 'uastc', families: 'bc', tileBytes: SIXTEEN_BYTE_BLOCKS_TILE, label: 'UASTC to BC7' },
      { mode: 'etc1s', families: 'etc2', tileBytes: EIGHT_BYTE_BLOCKS_TILE, label: 'ETC1S to ETC2' },
      { mode: 'uastc', families: 'astc', tileBytes: SIXTEEN_BYTE_BLOCKS_TILE, label: 'UASTC to ASTC 4x4' },
    ] as const;
    for (const { mode, families, tileBytes, label } of cases) {
      const ktx2 = await run(`ktx2=${mode}&compressed=${families}`);
      expect(ktx2.transcoderFetched, label).toBe(true);
      expect(ktx2.ready, label).toBeGreaterThan(0);
      expect(ktx2.gpuBytes, label).toBe(ktx2.ready * tileBytes);
      expect(ktx2.compressed, label).toBe(ktx2.ready);
      const { ratio } = compareImages(reference[mode].image, ktx2.image, CROSS_BACKEND.threshold);
      console.log(
        `${backend} ${label}: ${ktx2.gpuBytes} GPU bytes for ${ktx2.ready} tiles (PNG: ${png.gpuBytes} for ${png.ready}), ` +
          `${(ratio * 100).toFixed(3)}% pixels differ from RGBA8, PSNR ${psnr(png.image, ktx2.image).toFixed(1)} dB ` +
          `against the source, upload ms per tile median ${median(ktx2.uploadMs).toFixed(2)} ` +
          `(PNG ${median(png.uploadMs).toFixed(2)})`,
      );
      expect(ratio, label).toBeLessThanOrEqual(CROSS_BACKEND.maxDiffRatio);
    }
  });
}
