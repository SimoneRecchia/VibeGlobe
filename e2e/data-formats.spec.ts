// Vector data formats in data layers (M10, F371): GeoJSON, KML and GPX from a URL, a File and memory, parsed in the
// worker pool; corrupted documents give error events, never a crash or a blank view.
import { expect, test } from '@playwright/test';
import { canvasImage, openGlobe, waitForIdle } from './support/globe.ts';

declare global {
  interface Window {
    vibeglobeFormats?: {
      readonly tasks: readonly string[];
      load(
        format: 'geojson' | 'kml' | 'gpx',
        from: 'url' | 'file' | 'memory',
        corrupt?: boolean,
      ): Promise<{ counts: Record<string, number>; pointName: string; errors: string[] }>;
      clear(): void;
    };
  }
}

test.use({ viewport: { width: 480, height: 360 } });

const EXPECTED = {
  geojson: { point: 1, line: 1, polygon: 1 },
  kml: { point: 1, line: 1, polygon: 1 },
  gpx: { point: 1, line: 1, polygon: 0 },
} as const;

test('GeoJSON, KML and GPX load from a URL, a File and memory, parsed in a worker, and corrupted ones report errors (F371)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openGlobe(page, 'backend=webgl2&scenario=data-formats&lon=12.6&lat=41.85&zoom=9');
  await page.waitForFunction(() => window.vibeglobeFormats !== undefined);
  for (const format of ['geojson', 'kml', 'gpx'] as const) {
    for (const from of ['url', 'file', 'memory'] as const) {
      const result = await page.evaluate(([f, s]) => window.vibeglobeFormats?.load(f, s), [format, from] as const);
      expect(result?.errors, `${format} from ${from}`).toEqual([]);
      expect(result?.counts, `${format} from ${from}`).toEqual(EXPECTED[format]);
      if (format !== 'gpx') expect(result?.pointName).toBe('Roma');
    }
    // Parsed in a worker of the scenario's pool, not on the main thread (GeoJSON objects in memory included).
    expect(await page.evaluate(() => window.vibeglobeFormats?.tasks)).toContain(`parse-${format}`);
  }
  // The features are drawn: the red point at Rome.
  await waitForIdle(page);
  const at = await page.evaluate(() =>
    window.vibeglobePlayground?.globe.geoToScreen({ longitudeDeg: 12.5, latitudeDeg: 41.9 }),
  );
  const image = await canvasImage(page);
  let red = 0;
  for (let y = Math.round(at?.yPx ?? 0) - 3; y <= Math.round(at?.yPx ?? 0) + 3; y++)
    for (let x = Math.round(at?.xPx ?? 0) - 3; x <= Math.round(at?.xPx ?? 0) + 3; x++) {
      const i = (y * image.width + x) * 4;
      if ((image.data[i] ?? 0) > 200 && (image.data[i + 1] ?? 0) < 80 && (image.data[i + 2] ?? 0) < 80) red++;
    }
  expect(red).toBeGreaterThan(10);
  // Corrupted documents: an error event each, and the globe keeps drawing.
  await page.evaluate(() => window.vibeglobeFormats?.clear());
  for (const format of ['geojson', 'kml', 'gpx'] as const) {
    const result = await page.evaluate((f) => window.vibeglobeFormats?.load(f, 'file', true), format);
    expect(result?.errors.length, format).toBeGreaterThan(0);
  }
  const before = await page.evaluate(() => window.vibeglobePlayground?.globe.frameNumber ?? 0);
  await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ zoom: 8.5 }));
  await waitForIdle(page);
  expect(await page.evaluate(() => window.vibeglobePlayground?.globe.frameNumber ?? 0)).toBeGreaterThan(before);
  const after = await canvasImage(page);
  let lit = 0;
  for (let i = 0; i < after.data.length; i += 4 * 97) if ((after.data[i] ?? 0) + (after.data[i + 1] ?? 0) > 40) lit++;
  expect(lit).toBeGreaterThan((after.width * after.height * 0.5) / 97);
});
