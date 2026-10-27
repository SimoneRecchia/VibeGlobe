// The tilt policy (F625): beyond 20 km the view is flat and cannot tilt, the 3D button disabled; below 2 km it tilts by
// itself to 60°, continuously, and back to 0° rising. `?tiltPolicy=1` turns it on with its defaults.
import { expect, test, type Page } from '@playwright/test';
import { nextFrame, openGlobe, waitForIdle } from './support/globe.ts';

test.use({ viewport: { width: 480, height: 360 } });

/** Steps the zoom from `from` to `to` by 0.05 a frame; the camera's range and tilt in each frame. */
async function sweep(page: Page, from: number, to: number): Promise<{ range: number; tilt: number }[]> {
  const out: { range: number; tilt: number }[] = [];
  const step = from < to ? 0.05 : -0.05;
  for (let zoom = from; step > 0 ? zoom <= to : zoom >= to; zoom += step) {
    await page.evaluate((z) => window.vibeglobePlayground?.globe.jumpTo({ zoom: z }), zoom);
    await nextFrame(page);
    out.push(
      await page.evaluate(() => {
        const camera = window.vibeglobePlayground?.globe.camera;
        return { range: camera?.rangeMeters ?? 0, tilt: camera?.tiltDeg ?? 0 };
      }),
    );
  }
  return out;
}

test('far away the view stays flat with 3D disabled; close in it tilts to 60° and back, without a jump (F625)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openGlobe(page, 'backend=webgl2&tiltPolicy=1&ui=1&lon=7&lat=45&zoom=6');
  await waitForIdle(page);
  const threeD = page.locator('.vg-ui__button--view-3d');
  await expect(threeD).toBeDisabled();
  // Neither the API nor the 3D mode tilts it.
  await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ tiltDeg: 45 }));
  await waitForIdle(page);
  expect(await page.evaluate(() => window.vibeglobePlayground?.globe.camera.tiltDeg)).toBe(0);
  expect(await page.evaluate(() => window.vibeglobePlayground?.globe.viewMode)).toBe('auto');
  // Down to street scale and back: 0° beyond 2 km, 60° within 500 m, no step above 3° between frames.
  const down = await sweep(page, 9, 18.5);
  for (const { range, tilt } of down) {
    if (range > 2_050) expect(tilt).toBeLessThan(0.01);
    if (range < 480) expect(tilt).toBeCloseTo(60, 1);
  }
  await expect(threeD).toBeEnabled();
  const up = await sweep(page, 18.5, 9);
  expect(up.at(-1)?.tilt).toBeLessThan(0.01);
  for (const frames of [down, up])
    expect(Math.max(...frames.slice(1).map((f, i) => Math.abs(f.tilt - (frames[i]?.tilt ?? 0))))).toBeLessThan(3);
  await expect(threeD).toBeDisabled();
});
