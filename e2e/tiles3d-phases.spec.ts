// 3D Tiles in the globe, flattening, 2D map and 3D view phases (F465): through a continuous zoom from the globe to an
// oblique view of the fixture city, every drawn frame shows the reference buildings where the engine projects their
// WGS84 roofs (a ray there hits that building), so the tileset never jumps during the morph; and the same view
// captured on the globe and on the flat map matches in positions and colors.
import { expect, test, type Page } from '@playwright/test';
import { buildingHeight, buildingName } from './fixtures/tiles3d/city.ts';
import { canvasImage } from './support/globe.ts';
import { compareImages } from './support/visual.ts';
import { CITY, cityPoint, openCity, settleTiles } from './support/tiles3d.ts';

test.use({ viewport: { width: 320, height: 240 } });
test.setTimeout(180_000);

const REFERENCE: readonly [number, number][] = [
  [16, 16],
  [10, 20],
  [22, 9],
];

/** Records, every drawn frame, reference buildings that are big enough on screen yet missed by a ray at their roof. */
async function startAlignment(page: Page): Promise<void> {
  const references = REFERENCE.map(([i, j]) => ({
    i,
    j,
    name: buildingName(i, j),
    roof: cityPoint(-512 + 32 * i + 16, -512 + 32 * j + 16, buildingHeight(i, j)),
    edge: cityPoint(-512 + 32 * i + 26, -512 + 32 * j + 16, buildingHeight(i, j)),
  }));
  await page.evaluate((refs) => {
    const globe = window.vibeglobePlayground?.globe;
    const hooks = window.vibeglobeTiles3d;
    if (!globe || !hooks) throw new Error('no scenario');
    const record = { frames: 0, checks: 0, misses: [] as string[], phases: new Set<string>() };
    const off = globe.on('frame', () => {
      record.frames++;
      record.phases.add(globe.camera.phase);
      for (const ref of refs) {
        const at = globe.geoToScreen(ref.roof);
        const edge = globe.geoToScreen(ref.edge);
        if (!at || !edge || at.xPx < 2 || at.yPx < 2 || at.xPx > 318 || at.yPx > 238) continue;
        // Half the roof's width on screen: only buildings at least 8 px wide are checked.
        if (Math.hypot(edge.xPx - at.xPx, edge.yPx - at.yPx) < 4) continue;
        record.checks++;
        const pick = hooks.extension.pick(at.xPx, at.yPx);
        const name = String(pick?.properties['name'] ?? '');
        // The building, or the block of a coarser level that contains it (`block-<level>-<i0>-<j0>`).
        const block = /^block-(\d)-(\d+)-(\d+)$/.exec(name);
        const cells = block ? 2 ** (3 - Number(block[1])) : 0;
        const contains =
          name === ref.name ||
          (block !== null &&
            ref.i >= Number(block[2]) &&
            ref.i < Number(block[2]) + cells &&
            ref.j >= Number(block[3]) &&
            ref.j < Number(block[3]) + cells);
        // In an oblique view a taller building in front may hide the roof: the hit is then nearer than the roof.
        const eye = globe.camera;
        const rad = Math.PI / 180;
        const dLon = (ref.roof.longitudeDeg - eye.eyeLongitudeDeg) * 111_320 * Math.cos(ref.roof.latitudeDeg * rad);
        const dLat = (ref.roof.latitudeDeg - eye.eyeLatitudeDeg) * 110_950;
        const dUp = ref.roof.heightMeters - (eye.altitudeMeters + eye.groundHeightMeters);
        const roofDistance = Math.hypot(dLon, dLat, dUp);
        const hidden = pick !== undefined && pick.distanceMeters < roofDistance - 1;
        if (!contains && !hidden)
          record.misses.push(
            `${eye.phase} z${eye.zoom.toFixed(2)} ${ref.name}: ${name} at ${pick?.distanceMeters.toFixed(1)} m, roof ${roofDistance.toFixed(1)} m`,
          );
      }
    });
    (window as unknown as { alignment: { record: typeof record; off: () => void } }).alignment = { record, off };
  }, references);
}

async function stopAlignment(page: Page) {
  return page.evaluate(() => {
    const alignment = (
      window as unknown as {
        alignment: { record: { frames: number; checks: number; misses: string[]; phases: Set<string> }; off(): void };
      }
    ).alignment;
    alignment.off();
    return { ...alignment.record, phases: [...alignment.record.phases] };
  });
}

test('the tileset stays where the engine projects it through a zoom from the globe to an oblique view (F465)', async ({
  page,
}) => {
  await openCity(page, `backend=webgl2&lon=${CITY.longitudeDeg}&lat=${CITY.latitudeDeg}&zoom=3&tilt=0`);
  await settleTiles(page);
  await startAlignment(page);
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    await page.evaluate(
      async ({ city, zoom, tiltDeg }) => {
        await window.vibeglobePlayground?.globe.jumpTo({ ...city, zoom, tiltDeg });
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      },
      { city: { longitudeDeg: CITY.longitudeDeg, latitudeDeg: CITY.latitudeDeg }, zoom: 3 + 14 * t, tiltDeg: 45 * t },
    );
    if (i % 8 === 0) await settleTiles(page);
  }
  const alignment = await stopAlignment(page);
  console.log(`${alignment.frames} frames, ${alignment.checks} checks, phases ${alignment.phases.join(' ')}`);
  expect(alignment.phases).toEqual(expect.arrayContaining(['globe', 'flattening', '3d']));
  expect(alignment.checks).toBeGreaterThan(30);
  expect(alignment.misses).toEqual([]);
});

test('the same view on the globe and on the flat map matches in positions and colors (F465)', async ({ page }) => {
  const at = cityPoint(16, 16);
  await openCity(page, `backend=webgl2&lon=${at.longitudeDeg}&lat=${at.latitudeDeg}&zoom=17&tilt=0`);
  await settleTiles(page);
  const flat = await canvasImage(page);
  const flatPhase = await page.evaluate(() => window.vibeglobePlayground?.globe.camera.phase);
  // Curves of a globe: the map would flatten only past zoom 22, so this view goes back to the globe.
  await page.evaluate(() =>
    window.vibeglobePlayground?.globe.setViewCurves({
      morph: { startGroundZoom: 22, endGroundZoom: 23 },
      tilt: { startGroundZoom: 23.5, endGroundZoom: 24 },
    }),
  );
  await page.waitForFunction(() => window.vibeglobePlayground?.globe.camera.phase === 'globe');
  await settleTiles(page);
  const globe = await canvasImage(page);
  expect(['2d', '3d']).toContain(flatPhase);
  // Both captures show the city: buildings (warm beige, red above green) fill a good part of them.
  for (const image of [flat, globe]) {
    let buildings = 0;
    for (let i = 0; i < image.data.length; i += 4)
      if (
        (image.data[i] ?? 0) > (image.data[i + 1] ?? 0) + 12 &&
        (image.data[i + 1] ?? 0) > (image.data[i + 2] ?? 0) + 12
      )
        buildings++;
    expect(buildings).toBeGreaterThan(0.1 * image.width * image.height);
  }
  const { ratio } = compareImages(flat, globe, 0.1);
  console.log(`${(ratio * 100).toFixed(2)}% of pixels differ`);
  expect(ratio).toBeLessThan(0.01);
});
