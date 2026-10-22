// PMTiles and MBTiles packages shown on the globe (F232, F233): the same package from a server and from a local file
// gives identical frames, every tile at its place and no empty pixel.
import { expect, test, type Page } from '@playwright/test';

type SourcesHandle = NonNullable<Window['vibeglobeSources']>;
import { writeMbtiles } from '../packages/sources/src/__fixtures__/mbtiles-writer.ts';
import { writePmtiles } from '../packages/sources/src/__fixtures__/pmtiles-writer.ts';
import { emptyPixelsInside, silhouetteRadiusPx, waitForIdle } from './support/globe.ts';
import {
  expectCenterTileColor,
  fixturePyramid,
  openSources,
  sourceFrame,
  waitForSourceImagery,
} from './support/sources.ts';

const MAX_LEVEL = 3;
const VIEW = 'lon=12.5&lat=41.9&zoom=2.6';

/** Serves `bytes` cross-origin at `url`, with CORS headers and HTTP range requests. */
async function servePackage(page: Page, url: string, bytes: Uint8Array): Promise<void> {
  await page.route(url, async (route) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range',
      'Access-Control-Expose-Headers': 'Content-Range, ETag',
    };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const range = /bytes=(\d+)-(\d+)/.exec(route.request().headers()['range'] ?? '');
    if (!range) return route.fulfill({ status: 200, headers: cors, body: Buffer.from(bytes) });
    const start = Number(range[1]);
    const end = Math.min(bytes.length - 1, Number(range[2]));
    return route.fulfill({
      status: 206,
      headers: { ...cors, 'Content-Range': `bytes ${start}-${end}/${bytes.length}` },
      body: Buffer.from(bytes.subarray(start, end + 1)),
    });
  });
}

/** Mounts a source built in the page by `create` and returns the settled frame after checking it. */
async function settledFrame(page: Page, create: string, arg: unknown) {
  await page.evaluate(
    async ({ body, value }) => {
      const handle = window.vibeglobeSources;
      if (!handle) throw new Error('no handle');
      const build = new Function('sources', 'value', 'wasm', `return (${body})(sources, value, wasm);`) as (
        ...args: unknown[]
      ) => Promise<Parameters<SourcesHandle['mount']>[0]>;
      await handle.mount(await build(handle.sources, value, handle.sqlWasmUrl));
    },
    { body: create, value: arg },
  );
  await waitForSourceImagery(page, MAX_LEVEL);
  await waitForIdle(page);
  const frame = await sourceFrame(page);
  await expectCenterTileColor(page, frame);
  return frame;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

test.describe('archive adapters on the globe', () => {
  // Two globes are mounted and settled one after the other on the container's software GPU.
  test.setTimeout(180_000);

  test('a PMTiles archive over range requests and from a local Blob gives identical frames (F232)', async ({
    page,
  }) => {
    const archive = writePmtiles(fixturePyramid(MAX_LEVEL), { leafSize: 16 });
    await servePackage(page, 'http://archive.test/world.pmtiles', archive);
    await openSources(page, VIEW);
    const remote = await settledFrame(
      page,
      `(s) => s.pmtilesImagery({ id: 'remote', archive: 'http://archive.test/world.pmtiles' })`,
      null,
    );
    const local = await settledFrame(
      page,
      `(s, b64) => s.pmtilesImagery({ id: 'local', archive: new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]) })`,
      base64(archive),
    );
    expect(Buffer.compare(remote.data, local.data)).toBe(0);
    expect(emptyPixelsInside(local, await silhouetteRadiusPx(page, 0, '.vg-source-test canvas'))).toBe(0);
  });

  test('an MBTiles package from a LAN server and from a local file gives identical frames (F233)', async ({ page }) => {
    const bytes = await writeMbtiles(
      fixturePyramid(MAX_LEVEL),
      { format: 'png', minzoom: '0', maxzoom: '3' },
      'deduplicated',
    );
    await servePackage(page, 'http://nas.test/world.mbtiles', bytes);
    await openSources(page, VIEW);
    const remote = await settledFrame(
      page,
      `(s, _, wasm) => s.mbtilesImagery({ id: 'lan', package: 'http://nas.test/world.mbtiles', wasmUrl: wasm })`,
      null,
    );
    const local = await settledFrame(
      page,
      `(s, b64, wasm) => s.mbtilesImagery({ id: 'file', package: new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'world.mbtiles'), wasmUrl: wasm })`,
      base64(bytes),
    );
    expect(Buffer.compare(remote.data, local.data)).toBe(0);
    expect(emptyPixelsInside(local, await silhouetteRadiusPx(page, 0, '.vg-source-test canvas'))).toBe(0);
  });
});
