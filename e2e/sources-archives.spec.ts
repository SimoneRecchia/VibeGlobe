// PMTiles and MBTiles packages shown on the globe (F232, F233): the same package from a server and from a local file
// gives identical frames, every tile at its place and no empty pixel.
import { expect, test } from '@playwright/test';
import { writeMbtiles } from '../packages/sources/src/__fixtures__/mbtiles-writer.ts';
import { writePmtiles } from '../packages/sources/src/__fixtures__/pmtiles-writer.ts';
import {
  expectCenterTileColor,
  expectNoEmptyPixels,
  fixturePyramid,
  mountSource,
  openSources,
  servePackage,
  settledSourceFrame,
} from './support/sources.ts';

const MAX_LEVEL = 3;
const VIEW = 'lon=12.5&lat=41.9&zoom=2.6';

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
    await mountSource(page, `(s) => s.pmtilesImagery({ id: 'remote', archive: 'http://archive.test/world.pmtiles' })`);
    const remote = await settledSourceFrame(page, MAX_LEVEL);
    await expectCenterTileColor(page, remote);
    await mountSource(
      page,
      `(s, b64) => s.pmtilesImagery({ id: 'local', archive: new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))]) })`,
      base64(archive),
    );
    const local = await settledSourceFrame(page, MAX_LEVEL);
    expect(Buffer.compare(remote.data, local.data)).toBe(0);
    await expectNoEmptyPixels(page, local);
  });

  test('an MBTiles package from a LAN server and from a local file gives identical frames (F233)', async ({ page }) => {
    const tiles = fixturePyramid(MAX_LEVEL);
    const bytes = await writeMbtiles(tiles, { format: 'png', minzoom: '0', maxzoom: '3' }, 'deduplicated');
    await servePackage(page, 'http://nas.test/world.mbtiles', bytes);
    await openSources(page, VIEW);
    await mountSource(
      page,
      `(s, _, wasm) => s.mbtilesImagery({ id: 'lan', package: 'http://nas.test/world.mbtiles', wasmUrl: wasm })`,
    );
    const remote = await settledSourceFrame(page, MAX_LEVEL);
    await expectCenterTileColor(page, remote);
    await mountSource(
      page,
      `(s, b64, wasm) => s.mbtilesImagery({ id: 'file', package: new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'world.mbtiles'), wasmUrl: wasm })`,
      base64(bytes),
    );
    const local = await settledSourceFrame(page, MAX_LEVEL);
    expect(Buffer.compare(remote.data, local.data)).toBe(0);
    await expectNoEmptyPixels(page, local);
  });
});
