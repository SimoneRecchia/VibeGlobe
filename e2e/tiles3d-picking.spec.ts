// Picking on 3D Tiles (F466): clicks on buildings of the fixture city return the feature with its 1.1 property table
// values (glb with EXT_mesh_features and EXT_structural_metadata) or its 1.0 batch table values (b3dm), and the
// picked position and height match the building's known roof within tolerance.
import { expect, test } from '@playwright/test';
import { buildingHeight, buildingName } from './fixtures/tiles3d/city.ts';
import { CITY, cityPoint, openCity, settleTiles } from './support/tiles3d.ts';

test.use({ viewport: { width: 320, height: 240 } });

/** The roof center of the building in grid cell (i, j): 32 m cells from the city's south-west corner. */
const roof = (i: number, j: number) => cityPoint(-512 + 32 * i + 16, -512 + 32 * j + 16, buildingHeight(i, j));

test('clicks on 1.1 content return the building, its properties, position and height (F466)', async ({ page }) => {
  const center = roof(16, 16);
  await openCity(page, `backend=webgl2&lon=${center.longitudeDeg}&lat=${center.latitudeDeg}&zoom=16.6&tilt=0`);
  await settleTiles(page);
  const cells: [number, number][] = [
    [16, 16],
    [15, 16],
    [17, 15],
    [16, 17],
  ];
  for (const [i, j] of cells) {
    const expected = roof(i, j);
    const at = await page.evaluate((p) => window.vibeglobePlayground?.globe.geoToScreen(p), expected);
    if (!at) throw new Error(`building ${i},${j} is not on screen`);
    const box = await page.locator('canvas').boundingBox();
    const count = await page.evaluate(() => window.vibeglobeTiles3d?.picks.length ?? 0);
    // Clicks apart by more than the double-click interval, which zooms.
    await page.waitForTimeout(600);
    await page.mouse.click((box?.x ?? 0) + at.xPx, (box?.y ?? 0) + at.yPx);
    const picks = await page.evaluate(() => window.vibeglobeTiles3d?.picks ?? []);
    const target = await page.evaluate((p) => document.elementFromPoint(p.xPx, p.yPx)?.outerHTML.slice(0, 120), at);
    expect(picks.length, `${JSON.stringify(at)} ${target}`).toBe(count + 1);
    const pick = picks.at(-1);
    expect(pick?.properties['name']).toBe(buildingName(i, j));
    expect(pick?.properties['height']).toBeCloseTo(buildingHeight(i, j), 3);
    expect(typeof pick?.featureId).toBe('number');
    expect(pick?.tileId).toMatch(/children\[\d\]\.children\[\d\]\.children\[\d\]$/);
    const metersPerDegLon = 111_320 * Math.cos((CITY.latitudeDeg * Math.PI) / 180);
    expect(Math.abs((pick?.position.longitudeDeg ?? 0) - expected.longitudeDeg) * metersPerDegLon).toBeLessThan(1);
    expect(Math.abs((pick?.position.latitudeDeg ?? 0) - expected.latitudeDeg) * 110_950).toBeLessThan(1);
    expect(pick?.position.heightMeters).toBeCloseTo(expected.heightMeters, 0);
  }
});

test('clicks on 1.0 b3dm content return its batch table properties (F466)', async ({ page }) => {
  await openCity(page, `backend=webgl2&lon=${CITY.longitudeDeg}&lat=${CITY.latitudeDeg}&zoom=12.5&tilt=0`);
  await settleTiles(page);
  const levels = await page.evaluate(() => window.vibeglobeTiles3d?.extension.debugTiles().map((t) => t.level));
  expect(Math.max(...(levels ?? [9]))).toBeLessThanOrEqual(1);
  const box = await page.locator('canvas').boundingBox();
  await page.mouse.click((box?.x ?? 0) + 160, (box?.y ?? 0) + 120);
  const pick = await page.evaluate(() => window.vibeglobeTiles3d?.picks.at(-1));
  expect(String(pick?.properties['name'])).toMatch(/^(block-[01]-\d+-\d+|ground)$/);
  expect(typeof pick?.properties['height']).toBe('number');
  expect(typeof pick?.featureId).toBe('number');
});
