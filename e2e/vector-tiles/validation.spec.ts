// F451: a style with an unknown property, a wrongly typed value and a layer on a missing source loads; each problem is
// reported with its JSON path, and the valid layers render as they do without the broken ones. The reporting through
// the engine's log and `error` event waits for hook request D (1); the fuzzing is a unit test (vector-style.test.ts).
import { expect, test } from '@playwright/test';
import { capture, openVector } from './support.ts';

test.use({ viewport: { width: 320, height: 240 } });

const VIEW = 'scenario=mvt-flat&backend=webgl2&zoom=14&lon=9.19&lat=45.465';

test('problems are reported with their JSON path and the valid layers still render (F451)', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning') warnings.push(m.text());
  });
  await openVector(page, 'vectorStyle=streets&' + VIEW);
  const reference = await capture(page);
  await openVector(page, 'vectorStyle=broken&' + VIEW);
  const paths = await page.evaluate(() => window.vibeglobeVectorTiles?.layer?.style.problems.map((p) => p.path));
  expect(paths).toEqual(['layers[18].paint.fill-colr', 'layers[19].paint.line-width', 'layers[20]']);
  for (const path of paths ?? []) expect(warnings.some((w) => w.includes(path))).toBe(true);
  const ids = await page.evaluate(() => window.vibeglobeVectorTiles?.layer?.style.layers.map((l) => l.id));
  expect(ids).not.toContain('bad-source');
  // The broken properties fall back to their defaults: a black water fill and a 1 px black line on every road, so the
  // check compares only the pixels away from both.
  const image = await capture(page);
  let differing = 0;
  let compared = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const dark = (d: Uint8Array) => (d[i] ?? 0) + (d[i + 1] ?? 0) + (d[i + 2] ?? 0) < 120;
    if (dark(image.data) || dark(reference.data)) continue;
    compared++;
    if (Math.abs((image.data[i] ?? 0) - (reference.data[i] ?? 0)) > 16) differing++;
  }
  expect(compared).toBeGreaterThan(image.width * image.height * 0.5);
  expect(differing / compared).toBeLessThan(0.02);
});
