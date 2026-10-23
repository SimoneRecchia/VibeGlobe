// A dataset built by the pipeline records its license and attribution in its metadata (F337), and the engine shows
// the recorded credit while the output's tiles are in view. The build runs the built pipeline (npm run build) on the
// synthetic Sentinel-2-like GeoTIFF fixture, as the pipeline's own tests do.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { mountSource, openSources, waitForSourceIdle } from './support/sources.ts';

const TIF = readFileSync('packages/tools/src/fixtures/rgb-lzw.tif');
const BUILD = '../packages/tools/dist/pipeline/build.js';

let dir = '';
let archive = Buffer.alloc(0);
let metadata: Record<string, unknown> = {};

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vibeglobe-f337-'));
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      configVersion: '1.0.0',
      name: 'f337',
      description: 'F337 sample',
      region: { bbox: [11, 39, 15, 43] },
      sampleArea: { bbox: [11, 39, 15, 43] },
      prices: {
        currency: 'USD',
        readDate: '2026-10-21',
        sourceUrl: 'https://example.test',
        requesterPaysTransferPerGB: 0.09,
        requesterPaysGetPer1000: 0.0004,
        freeTransferPerGB: 0,
      },
      tools: { gdal: `ghcr.io/osgeo/gdal@sha256:${'a'.repeat(64)}` },
      datasets: [
        {
          id: 'imagery',
          kind: 'imagery',
          profile: 's2cloudless-2016',
          dataYear: 2016,
          sourceVersion: '2016',
          source: { type: 'geotiff', url: 'https://tif.test/rgb.tif' },
          minZoom: 3,
          maxZoom: 6,
          encoding: 'jpeg',
          bytesPerTile: 20_000,
          downloadBytesPerFile: TIF.length,
          outputs: { static: true, pmtiles: true, mbtiles: false },
        },
      ],
    }),
  );
  const { runBuild } = (await import(BUILD)) as { runBuild: (options: Record<string, unknown>) => Promise<unknown> };
  await runBuild({
    configPath: join(dir, 'config.json'),
    outDir: join(dir, 'out'),
    sample: false,
    yes: true,
    interactive: false,
    until: 'package',
    fetch: (async () => new Response(TIF)) as typeof fetch,
    ask: () => Promise.resolve(false),
    report: () => undefined,
  });
  archive = readFileSync(join(dir, 'out', 'output', 'imagery.pmtiles'));
  metadata = JSON.parse(readFileSync(join(dir, 'out', 'output', 'imagery', 'metadata.json'), 'utf8')) as Record<
    string,
    unknown
  >;
});
test.afterAll(() => rmSync(dir, { recursive: true, force: true }));

const credits = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.vg-source-test .vg-credits .vg-credit')].map(
      (item) => item.textContent?.trim() ?? '',
    ),
  );

test('the pipeline records license and attribution, and the engine shows the recorded credit while its tiles show (F337)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // The static folder's metadata file carries every field the entry names.
  expect(metadata).toMatchObject({
    license: 'CC-BY-4.0',
    attribution: expect.stringContaining('Sentinel-2 cloudless'),
    dataYear: 2016,
    configName: 'f337',
    configVersion: '1.0.0',
    pipelineVersion: expect.any(String),
    sources: [expect.objectContaining({ url: 'https://s2maps.eu', license: 'CC-BY-4.0' })],
  });
  // The PMTiles output, loaded through the engine's PMTiles adapter.
  await openSources(page, 'lon=13&lat=41&zoom=5');
  await mountSource(
    page,
    `(s, b64) => s.pmtilesImagery({ id: 'pipeline', archive: new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]) })`,
    archive.toString('base64'),
  );
  // The output covers only its region: tiles elsewhere have no data, so wait for the loading to end.
  await waitForSourceIdle(page);
  await expect.poll(() => credits(page)).toContain(String(metadata['attribution']));
  // Away from its tiles, the credit goes.
  await page.evaluate(() => window.vibeglobeSources?.globe?.jumpTo({ longitudeDeg: -100, latitudeDeg: 40, zoom: 6 }));
  await expect.poll(() => credits(page)).not.toContain(String(metadata['attribution']));
});
