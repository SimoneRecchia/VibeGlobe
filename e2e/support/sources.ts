// A globe with one imagery source of `@vibeglobe/sources` mounted over the playground, for the source adapters
// track's end-to-end tests. The playground stays as it is: the tests import the packages' sources through the Vite dev
// server and use the engine through its public API only (docs/parallel-tracks.md).
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import type * as CoreModule from '@vibeglobe/core';
import type * as RendererModule from '@vibeglobe/renderer';
import type * as SourcesModule from '@vibeglobe/sources';
import type * as WorkerModule from '@vibeglobe/worker';
import { PNG } from 'pngjs';
import { BACKGROUND_RGB, openGlobe } from './globe.ts';

/** What the tests reach on the page (`window.vibeglobeSources`). */
interface SourcesTestHandle {
  readonly sources: typeof SourcesModule;
  /** Replaces the mounted globe with one showing `source` over the base image. */
  mount(source: CoreModule.ImagerySource): Promise<void>;
  globe?: CoreModule.Globe;
  /** URL of sql.js's WebAssembly file, served by the dev server. */
  readonly sqlWasmUrl: string;
}

declare global {
  interface Window {
    vibeglobeSources?: SourcesTestHandle;
  }
}

const fsUrl = (path: string): string => `/@fs${resolve(path)}`;

/** Opens the playground at a view, removes its globe and prepares the source globe's modules. */
export async function openSources(page: Page, query: string): Promise<void> {
  await openGlobe(page, query);
  const backend = /backend=(webgpu|webgl2)/.exec(query)?.[1] ?? 'auto';
  await page.evaluate(
    async ({ entries, backend: choice, sqlWasmUrl }) => {
      const core = (await import(/* @vite-ignore */ entries.core)) as typeof CoreModule;
      const renderer = (await import(/* @vite-ignore */ entries.renderer)) as typeof RendererModule;
      const worker = (await import(/* @vite-ignore */ entries.worker)) as typeof WorkerModule;
      const sources = (await import(/* @vite-ignore */ entries.sources)) as typeof SourcesModule;
      const playground = window.vibeglobePlayground?.globe;
      if (!playground) throw new Error('no playground globe');
      const view = { ...playground.camera };
      playground.destroy();
      const host = document.getElementById('app') ?? document.body;
      const workers = worker.createWorkers();
      const handle: SourcesTestHandle = {
        sources,
        sqlWasmUrl,
        async mount(source) {
          handle.globe?.destroy();
          host.querySelectorAll('.vg-source-test').forEach((node) => node.remove());
          const container = document.createElement('div');
          container.className = 'vg-source-test';
          container.style.cssText = 'position:absolute;inset:0';
          const canvas = document.createElement('canvas');
          canvas.style.cssText = 'width:100%;height:100%;display:block';
          container.append(canvas);
          host.append(container);
          const globe = core.createGlobe({
            container,
            renderer: renderer.createRenderer({ backend: choice as 'auto' | 'webgpu' | 'webgl2', canvas }),
            baseImageryUrl: '/imagery/natural-earth-4096.jpg',
            view: {
              longitudeDeg: view.longitudeDeg,
              latitudeDeg: view.latitudeDeg,
              zoom: view.zoom,
              headingDeg: view.headingDeg,
              tiltDeg: view.tiltDeg,
            },
            imagery: [source],
            workers,
          });
          handle.globe = globe;
          await globe.ready;
        },
      };
      window.vibeglobeSources = handle;
    },
    {
      entries: {
        core: fsUrl('packages/core/src/index.ts'),
        renderer: fsUrl('packages/renderer/src/index.ts'),
        worker: fsUrl('packages/worker/src/index.ts'),
        sources: fsUrl('packages/sources/src/index.ts'),
      },
      backend,
      sqlWasmUrl: fsUrl('node_modules/sql.js/dist/sql-wasm-browser.wasm'),
    },
  );
}

/** Waits until every Mercator tile of the mounted globe shows imagery of its level (or the source's deepest one). */
export async function waitForSourceImagery(page: Page, maxLevel: number): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((max) => {
          const tiles = window.vibeglobeSources?.globe?.surfaceTiles() ?? [];
          return (
            tiles.length > 0 && tiles.every((t) => t.root !== 'mercator' || t.imageryLevel === Math.min(t.level, max))
          );
        }, maxLevel),
      { timeout: 60_000 },
    )
    .toBe(true);
}

/** The mounted globe's current frame, composited over the page background. */
export async function sourceFrame(page: Page): Promise<PNG> {
  const frame = await page.evaluate(async () => {
    const capture = await window.vibeglobeSources?.globe?.captureFrame();
    if (!capture) throw new Error('no source globe');
    const bytes = new Uint8Array(capture.rgba.buffer, capture.rgba.byteOffset, capture.rgba.byteLength);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return { widthPx: capture.widthPx, heightPx: capture.heightPx, base64: btoa(binary) };
  });
  const rgba = Buffer.from(frame.base64, 'base64');
  const image = new PNG({ width: frame.widthPx, height: frame.heightPx });
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3] ?? 0;
    for (let c = 0; c < 3; c++)
      image.data[i + c] = Math.round(((rgba[i + c] ?? 0) * alpha + (BACKGROUND_RGB[c] ?? 0) * (255 - alpha)) / 255);
    image.data[i + 3] = 255;
  }
  return image;
}

/** The fixture color of tile `z/x/y`: distinct per tile, never dark. */
function tileColor(z: number, x: number, y: number): [number, number, number] {
  return [((x * 67 + z * 31) % 180) + 60, ((y * 89 + z * 17) % 180) + 60, ((z * 53 + x + y) % 180) + 60];
}

/** A 256-pixel PNG tile filled with its fixture color. */
function tilePng(z: number, x: number, y: number): Uint8Array {
  const png = new PNG({ width: 256, height: 256 });
  const [r, g, b] = tileColor(z, x, y);
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = r;
    png.data[i + 1] = g;
    png.data[i + 2] = b;
    png.data[i + 3] = 255;
  }
  return new Uint8Array(PNG.sync.write(png));
}

/** Every Web Mercator tile of levels 0 to `maxLevel` as fixture PNGs, keyed `z/x/y`. */
export function fixturePyramid(maxLevel: number): Map<string, Uint8Array> {
  const tiles = new Map<string, Uint8Array>();
  for (let z = 0; z <= maxLevel; z++)
    for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) tiles.set(`${z}/${x}/${y}`, tilePng(z, x, y));
  return tiles;
}

/**
 * Asserts the pixel at the screen center has the color of the fixture tile that contains the center position at the
 * level its surface tile shows, so tiles land at their geographic place.
 */
export async function expectCenterTileColor(page: Page, image: PNG): Promise<void> {
  const center = await page.evaluate(() => {
    const globe = window.vibeglobeSources?.globe;
    const canvas = document.querySelector('.vg-source-test canvas');
    const point = { xPx: (canvas?.clientWidth ?? 0) / 2, yPx: (canvas?.clientHeight ?? 0) / 2 };
    const geo = globe?.screenToGeo(point);
    const tile = globe
      ?.surfaceTiles()
      .find(
        (t) =>
          geo &&
          t.westDeg <= geo.longitudeDeg &&
          geo.longitudeDeg <= t.eastDeg &&
          t.southDeg <= geo.latitudeDeg &&
          geo.latitudeDeg <= t.northDeg,
      );
    return geo && tile ? { ...geo, level: tile.imageryLevel ?? 0 } : undefined;
  });
  if (!center) throw new Error('nothing under the screen center');
  const n = 2 ** center.level;
  const lat = (center.latitudeDeg * Math.PI) / 180;
  const x = Math.floor(((center.longitudeDeg + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n);
  const expected = tileColor(center.level, x, y);
  const i = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4;
  const actual = [image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0];
  for (let c = 0; c < 3; c++) expect(Math.abs((actual[c] ?? 0) - (expected[c] ?? 0))).toBeLessThanOrEqual(8);
}
