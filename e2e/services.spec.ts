// F699: `createVibeGlobe` starts a globe on any page from the application's services: the tiles are required, the
// terrain and the geocoder optional, and a missing optional service only turns its feature off.
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type * as SourcesModule from '@vibeglobe/sources';
import type * as VibeGlobeModule from 'vibeglobe';
import { openGlobe, pageImage } from './support/globe.ts';

declare global {
  interface Window {
    servicesTest?: { started?: VibeGlobeModule.VibeGlobe; error?: string; searches: string[] };
  }
}

const fsUrl = (path: string): string => `/@fs${resolve(path)}`;
const ENTRIES = {
  vibeglobe: fsUrl('packages/vibeglobe/src/index.ts'),
  sources: fsUrl('packages/sources/src/index.ts'),
};

/** A 1×1 ocean-blue base image: the shares below count what the tiles draw over it, not the shipped day image. */
const OCEAN =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQsY8BAAEyALi+BX15AAAAAElFTkSuQmCC';

/** Which services the page plugs in: fixture tiles (raster or the streets style), terrain, a geocoder stub. */
interface Plan {
  readonly tiles: 'raster' | 'style' | 'none';
  readonly terrain?: boolean;
  readonly geocoder?: boolean;
  readonly view: { longitudeDeg: number; latitudeDeg: number; zoom: number; tiltDeg?: number };
}

/** Replaces the playground's globe with one `createVibeGlobe` starts with the plan's services. */
async function start(page: Page, plan: Plan): Promise<void> {
  await openGlobe(page);
  await page.evaluate(
    async ({ entries, plan: p, ocean }) => {
      const { createVibeGlobe } = (await import(/* @vite-ignore */ entries.vibeglobe)) as typeof VibeGlobeModule;
      const sources = (await import(/* @vite-ignore */ entries.sources)) as typeof SourcesModule;
      window.vibeglobePlayground?.globe.destroy();
      document.body.replaceChildren();
      const container = document.createElement('div');
      container.style.cssText = 'position:fixed;inset:0';
      document.body.append(container);
      const state: NonNullable<Window['servicesTest']> = { searches: [] };
      window.servicesTest = state;
      const raster = sources.xyzImagery({ id: 'world', url: '/fixture-tiles/services/world/mercator/{z}/{x}/{y}.png' });
      const tiles =
        p.tiles === 'raster'
          ? { imagery: [raster] }
          : p.tiles === 'style'
            ? { imagery: [], style: '/vector-tiles/styles/streets.json' }
            : undefined;
      const terrain = sources.heightmapTerrain({
        id: 'dem',
        url: '/fixture-tiles/services/terrain/mercator/{z}/{x}/{y}.terrarium.png',
        encoding: 'terrarium',
        maxLevel: 10,
      });
      const geocoder = {
        search: async (query: string) => {
          state.searches.push(query);
          return [{ label: `${query} Town`, longitudeDeg: 11, latitudeDeg: 46, zoom: 9 }];
        },
      };
      try {
        state.started = await createVibeGlobe(container, {
          tiles: tiles as never,
          baseImageryUrl: ocean,
          view: p.view,
          ...(p.terrain ? { terrain } : {}),
          ...(p.geocoder ? { geocoder } : {}),
        });
      } catch (error) {
        state.error = (error as { code?: string }).code ?? String(error);
      }
    },
    { entries: ENTRIES, plan, ocean: OCEAN },
  );
}

/** The share of the page's pixels that are not the plain ocean shown where no tile is drawn. */
async function drawnShare(page: Page): Promise<number> {
  const png = await pageImage(page, 'canvas');
  let drawn = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const d =
      Math.abs((png.data[i] ?? 0) - 28) + Math.abs((png.data[i + 1] ?? 0) - 63) + Math.abs((png.data[i + 2] ?? 0) - 92);
    if (d > 40) drawn++;
  }
  return drawn / (png.width * png.height);
}

/** Waits until the started globe draws a tile with imagery (or terrain). */
async function settle(page: Page, check: 'imagery' | 'terrain'): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((field) => {
          const tiles = window.servicesTest?.started?.globe.surfaceTiles() ?? [];
          return tiles.some((tile) => (field === 'imagery' ? tile.imageryLevel : tile.terrainLevel) !== null);
        }, check),
      { timeout: 30_000 },
    )
    .toBe(true);
}

test.describe('createVibeGlobe (F699)', () => {
  test.setTimeout(60_000);

  test('refuses to start without a tile service and leaves nothing on the page', async ({ page }) => {
    await start(page, { tiles: 'none', view: { longitudeDeg: 0, latitudeDeg: 0, zoom: 2 } });
    expect(await page.evaluate(() => window.servicesTest?.error)).toBe('invalid-option');
    expect(await page.locator('canvas').count()).toBe(0);
  });

  test('draws the tiles with neither terrain nor geocoder: a flat surface and a search box for coordinates', async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await start(page, { tiles: 'raster', view: { longitudeDeg: 11, latitudeDeg: 46, zoom: 4 } });
    expect(await page.evaluate(() => window.servicesTest?.error)).toBeUndefined();
    await settle(page, 'imagery');
    expect(
      await page.evaluate(() =>
        window.servicesTest?.started?.globe.surfaceTiles().every((t) => t.terrainLevel === null),
      ),
    ).toBe(true);
    const search = page.locator('.vg-ui input').first();
    await search.fill('Bolzano');
    await expect(page.locator('.vg-ui')).toContainText(/coordinates/i);
    expect(await drawnShare(page)).toBeGreaterThan(0.2);
    await info.attach('raster-only', { body: await page.screenshot(), contentType: 'image/png' });
    expect(errors).toEqual([]);
  });

  test('uses the terrain and geocoder services when given', async ({ page }) => {
    await start(page, {
      tiles: 'raster',
      terrain: true,
      geocoder: true,
      view: { longitudeDeg: 11, latitudeDeg: 46, zoom: 8, tiltDeg: 40 },
    });
    await settle(page, 'terrain');
    const search = page.locator('.vg-ui input').first();
    await search.fill('Bolz');
    await expect(page.locator('.vg-ui')).toContainText('Bolz Town');
    expect(await page.evaluate(() => window.servicesTest?.searches)).toContain('Bolz');
  });

  test("draws a style-only tile service's vector map", async ({ page }, info) => {
    await start(page, { tiles: 'style', view: { longitudeDeg: 9.19, latitudeDeg: 45.465, zoom: 14 } });
    expect(await page.evaluate(() => window.servicesTest?.error)).toBeUndefined();
    await expect.poll(() => drawnShare(page), { timeout: 30_000 }).toBeGreaterThan(0.5);
    await info.attach('style-only', { body: await page.screenshot(), contentType: 'image/png' });
    await page.evaluate(() => window.servicesTest?.started?.destroy());
    expect(await page.locator('canvas').count()).toBe(0);
  });
});
