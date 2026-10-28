// KB-203: the engine reports idle only once the data layers' labels are drawn, so a capture at the first idle already
// shows every label (the canonical data-labels view on WebGPU, where CI's software GPU missed them before the fix).
import { expect, test } from '@playwright/test';
import { openGlobe, waitForIdle } from './support/globe.ts';
import { captureCanvas, compareImages } from './support/visual.ts';

test('the first idle after the data layers start already shows every label on webgpu (KB-203)', async ({ page }) => {
  // The label fields arrive late, as on a busy page: the worker that makes them starts 1.5 s after it is asked for.
  await page.route('**/label-sdf-worker*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  for (let run = 0; run < 2; run++) {
    await openGlobe(page, 'backend=webgpu&scenario=data-labels&viewMode=2d&lon=18.5&lat=43.8&zoom=5');
    // The scenario's module loads after the globe is ready: the engine may go idle before it adds the layers (KB-229).
    await page.waitForFunction(() => window.vibeglobeLayers !== undefined);
    await waitForIdle(page);
    const first = await captureCanvas(page);
    // Nothing changes afterwards: the view keeps drawing nothing new over the next idles.
    await page.waitForTimeout(1000);
    await waitForIdle(page);
    const settled = await captureCanvas(page);
    expect(compareImages(first, settled, 0).differing, `run ${String(run)}`).toBe(0);
  }
});
