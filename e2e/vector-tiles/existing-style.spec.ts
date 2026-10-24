// F444: an existing, openly licensed MapLibre style (MapLibre's demotiles style, BSD-3-Clause, kept verbatim in
// apps/playground/public/vector-tiles/styles/demotiles.json) loads without edits: its URLs are mapped to the fixture
// tiles and glyphs by `transformUrl`, it validates without problems, every layer is created (its GeoJSON source
// included), and its canonical views match their baselines (hook request D (3)) on both backends.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { expectMatchesBaseline } from '../support/visual.ts';
import { BACKENDS, capture, hex, near, openVector, rgbAt, settle } from './support.ts';

test.use({ viewport: { width: 480, height: 360 } });

const STYLE = JSON.parse(
  readFileSync(new URL('../../apps/playground/public/vector-tiles/styles/demotiles.json', import.meta.url), 'utf8'),
) as { layers: { id: string }[] };

for (const backend of BACKENDS) {
  test(`the demotiles style loads unchanged, valid, with all its layers (${backend}, F444)`, async ({ page }) => {
    await openVector(page, `vectorStyle=demotiles&backend=${backend}&zoom=3&lon=30&lat=42`);
    const loaded = await page.evaluate(() => {
      const layer = window.vibeglobeVectorTiles?.layer;
      return { problems: layer?.style.problems ?? [], ids: layer?.style.layers.map((l) => l.id) ?? [] };
    });
    expect(loaded.problems).toEqual([]);
    expect(loaded.ids).toEqual(STYLE.layers.map((l) => l.id));
    // Drawn as the style says: the sea's background, a country's fill, the GeoJSON source's Crimea, the labels.
    await page.evaluate(() => {
      const layer = window.vibeglobeVectorTiles?.layer;
      for (const id of ['geolines-label', 'countries-label']) layer?.style.setVisibility(id, false);
    });
    await settle(page);
    const image = await capture(page);
    const at = async (longitudeDeg: number, latitudeDeg: number) => {
      const p = await page.evaluate((g) => window.vibeglobePlayground?.globe.geoToScreen(g), {
        longitudeDeg,
        latitudeDeg,
      });
      if (p === undefined) throw new Error('off screen');
      return rgbAt(image, p.xPx, p.yPx);
    };
    expect(near(await at(20, 36), hex('#D8F2FF'), 10)).toBe(true);
    expect(near(await at(34.2, 45.3), hex('#D6C7FF'), 10)).toBe(true);
  });

  test(`canonical views of the demotiles style match their baselines (${backend}, F444) @baseline`, async ({
    page,
  }, testInfo) => {
    await openVector(page, `vectorStyle=demotiles&backend=${backend}&zoom=1.5&lon=15&lat=30`);
    await expectMatchesBaseline(page, testInfo, `mvt-demotiles-globe-${backend}.png`, await capture(page));
    await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 30, latitudeDeg: 42, zoom: 4 }));
    await settle(page);
    await expectMatchesBaseline(page, testInfo, `mvt-demotiles-europe-${backend}.png`, await capture(page));
  });
}
