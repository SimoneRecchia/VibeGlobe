// The playground's wind turbine and solar table (`?scenario=energy-park`, F648, F656, which replaced F649): rotors
// turning at a speed set at runtime, frames only while a turning rotor is drawn, and both models drawn as a few
// instanced draws.
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { BACKGROUND_RGB, canvasImage, openGlobe, waitForIdle } from './support/globe.ts';

interface ModelSetHooks {
  setVisible(visible: boolean): void;
  setSpinRpm(rpm: number, id?: string): boolean;
  setYawDeg(facingDeg: number, id?: string): boolean;
  framePositions(ids?: readonly string[]): { longitudeDeg: number; latitudeDeg: number; heightMeters?: number }[];
}

declare global {
  interface Window {
    vibeglobeEnergyPark?: {
      turbines: ModelSetHooks;
      solar: ModelSetHooks;
      frame(turbineIds?: readonly string[]): Promise<string>;
    };
  }
}

test.use({ viewport: { width: 640, height: 480 } });

/** From the south-west, low over the ground, the first turbine large in the foreground. */
const ROTOR_VIEW = 'lon=9.409544&lat=45.110736&zoom=16.6&tilt=84&heading=48';
/** The turbine's triangles (tower, nacelle and rotor) and the solar table's (structure and glass). */
const TURBINE_TRIANGLES = 1850;
const TABLE_TRIANGLES = 188;

async function openPark(page: Page, query: string): Promise<void> {
  await openGlobe(page, `backend=webgl2&scenario=energy-park&${query}`);
  await page.waitForFunction(() => window.vibeglobeEnergyPark !== undefined, undefined, { timeout: 60_000 });
  await waitForIdle(page);
}

/** Pixels whose color differs by more than 24 in a channel. */
function changedPixels(a: PNG, b: PNG): number {
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4)
    for (let k = 0; k < 3; k++)
      if (Math.abs((a.data[i + k] ?? 0) - (b.data[i + k] ?? 0)) > 24) {
        changed++;
        break;
      }
  return changed;
}

/** Draw calls and triangles a layer adds to a frame: drawn with it shown, then hidden. */
async function layerCost(page: Page, layer: 'turbines' | 'solar'): Promise<{ drawCalls: number; triangles: number }> {
  const stats = async (visible: boolean) => {
    await page.evaluate(([name, v]) => window.vibeglobeEnergyPark?.[name].setVisible(v), [layer, visible] as const);
    await waitForIdle(page);
    return page.evaluate(() => window.vibeglobePlayground?.globe.rendererStats() ?? { drawCalls: 0, triangles: 0 });
  };
  const shown = await stats(true);
  const hidden = await stats(false);
  await page.evaluate((name) => window.vibeglobeEnergyPark?.[name].setVisible(true), layer);
  return { drawCalls: shown.drawCalls - hidden.drawCalls, triangles: shown.triangles - hidden.triangles };
}

test('rotors spin at the speed set and ease to a stop, nacelles turn into the wind, frames only while in view (F648)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openPark(page, `rpm=0&ramp=0.5&yawSpeed=90&clockStepMs=16&${ROTOR_VIEW}`);
  const still = await canvasImage(page);
  await page.evaluate(() => window.vibeglobeEnergyPark?.turbines.setSpinRpm(12));
  // Turning: frames come with no input, and the blades move between them (12 turns a minute, 1.2° a frame).
  const from = await page.evaluate(() => window.vibeglobePlayground?.globe.frameNumber ?? 0);
  await page.waitForFunction((f) => (window.vibeglobePlayground?.globe.frameNumber ?? 0) > f + 30, from);
  const turning = await canvasImage(page);
  console.log(`[F648] pixels changed by the turning rotors: ${String(changedPixels(still, turning))}`);
  expect(changedPixels(still, turning)).toBeGreaterThan(200);
  // Stopped: once the ramp has ended the globe goes idle and the picture stays still.
  await page.evaluate(() => window.vibeglobeEnergyPark?.turbines.setSpinRpm(0));
  await waitForIdle(page);
  const [a, b] = [await canvasImage(page), await canvasImage(page)];
  expect(changedPixels(a, b)).toBe(0);
  // The wind turns from west to south: the nacelles follow it, then the globe goes idle again.
  await page.evaluate(() => window.vibeglobeEnergyPark?.turbines.setYawDeg(180));
  await waitForIdle(page);
  const turned = await canvasImage(page);
  console.log(`[F648] pixels changed by the nacelles turning: ${String(changedPixels(b, turned))}`);
  expect(changedPixels(b, turned)).toBeGreaterThan(200);
  // Turning again but out of view: no turbine is drawn, so no frame is asked for and the globe goes idle.
  await page.evaluate(() => window.vibeglobeEnergyPark?.turbines.setSpinRpm(12));
  await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 12, latitudeDeg: 42, zoom: 12 }));
  await waitForIdle(page);
});

test('the turbine and the solar table cost a few instanced draws, the panels facing south (F649)', async ({ page }) => {
  test.setTimeout(120_000);
  // The default view: the solar park in front of the turbines, from the south.
  await openPark(page, 'rpm=0');
  const turbines = await layerCost(page, 'turbines');
  const solar = await layerCost(page, 'solar');
  console.log(`[F649] turbines ${JSON.stringify(turbines)}, solar ${JSON.stringify(solar)}`);
  // The tower, the nacelle and the rotor: three draws for every turbine in view.
  expect(turbines.drawCalls).toBe(3);
  expect(turbines.triangles % TURBINE_TRIANGLES).toBe(0);
  expect(turbines.triangles / TURBINE_TRIANGLES).toBeGreaterThanOrEqual(6);
  // The structure, the glass and the far tables' placeholder.
  expect(solar.drawCalls).toBeLessThanOrEqual(3);
  expect(solar.triangles).toBeGreaterThan(300 * TABLE_TRIANGLES);
  // Low over the park, 15° above the horizon (under the tables' 20°): from the south the glass of the modules fills the
  // view (dark blue), from the north their backs and the steel (light grey).
  const blueShare = async (headingDeg: number): Promise<number> => {
    await page.evaluate(
      (h) =>
        window.vibeglobePlayground?.globe.jumpTo({
          longitudeDeg: 9.4103,
          latitudeDeg: 45.1011,
          zoom: 18.6,
          tiltDeg: 75,
          headingDeg: h,
        }),
      headingDeg,
    );
    await waitForIdle(page);
    const image = await canvasImage(page);
    let blue = 0;
    for (let i = 0; i < image.data.length; i += 4) {
      const [r, g, bl] = [image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0];
      // Dark blue, the page's background behind the sky left out.
      const sky =
        Math.abs(r - BACKGROUND_RGB[0]) + Math.abs(g - BACKGROUND_RGB[1]) + Math.abs(bl - BACKGROUND_RGB[2]) < 24;
      if (!sky && bl > r + 12 && r + g + bl < 360) blue++;
    }
    return blue / (image.data.length / 4);
  };
  const fromSouth = await blueShare(0);
  const fromNorth = await blueShare(180);
  console.log(`[F649] dark blue share from the south ${fromSouth.toFixed(2)}, from the north ${fromNorth.toFixed(2)}`);
  expect(fromSouth).toBeGreaterThan(0.4);
  expect(fromNorth).toBeLessThan(0.15);
});

test('a flight to a turbine frames it whole and centered, and one to the park frames every device (F667, KB-301)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // The movement is a flight; reduced motion makes it a short fade (F214).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openPark(page, 'rpm=0');
  const size = await page.evaluate(() => {
    const canvas = document.querySelector('#globe');
    return { width: canvas?.clientWidth ?? 0, height: canvas?.clientHeight ?? 0 };
  });
  /** The screen points of the given turbines' boxes, or of every device. */
  const shown = (ids?: string[]) =>
    page.evaluate((only) => {
      const park = window.vibeglobeEnergyPark;
      const globe = window.vibeglobePlayground?.globe;
      const corners = only
        ? (park?.turbines.framePositions(only) ?? [])
        : [...(park?.turbines.framePositions() ?? []), ...(park?.solar.framePositions() ?? [])];
      return corners.map((corner) => globe?.geoToScreen(corner) ?? null);
    }, ids);
  const inside = (points: ({ xPx: number; yPx: number } | null)[]) =>
    points.every(
      (p) => p !== null && p.xPx >= 39 && p.xPx <= size.width - 39 && p.yPx >= 39 && p.yPx <= size.height - 39,
    );

  expect(await page.evaluate(() => window.vibeglobeEnergyPark?.frame(['turbine-3']))).toBe('completed');
  await waitForIdle(page);
  const turbine = await shown(['turbine-3']);
  expect(inside(turbine)).toBe(true);
  const xs = turbine.map((p) => p?.xPx ?? NaN);
  const ys = turbine.map((p) => p?.yPx ?? NaN);
  console.log(
    `[F667] turbine box on screen: x ${Math.min(...xs).toFixed(0)}–${Math.max(...xs).toFixed(0)}, y ${Math.min(...ys).toFixed(0)}–${Math.max(...ys).toFixed(0)}`,
  );
  // Snug (a side touches the padding), and centered: the box's middle at the view's center.
  const slack = Math.min(
    Math.min(...xs) - 40,
    size.width - 40 - Math.max(...xs),
    Math.min(...ys) - 40,
    size.height - 40 - Math.max(...ys),
  );
  expect(slack).toBeLessThan(4);
  expect(Math.abs((Math.max(...ys) + Math.min(...ys)) / 2 - size.height / 2)).toBeLessThan(size.height * 0.08);
  expect(Math.abs((Math.max(...xs) + Math.min(...xs)) / 2 - size.width / 2)).toBeLessThan(size.width * 0.08);

  expect(await page.evaluate(() => window.vibeglobeEnergyPark?.frame())).toBe('completed');
  await waitForIdle(page);
  expect(inside(await shown())).toBe(true);
});
