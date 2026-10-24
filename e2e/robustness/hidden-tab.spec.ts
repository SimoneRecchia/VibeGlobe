// Hidden and visible tab transitions (F515): the tab is hidden during a flight and while idle, and shown again after
// 1 and 10 minutes. The hidden time is simulated (`support/page-clock.ts`): the page's clock jumps by the hidden time
// while the page is hidden for a short real interval. While hidden no frame is drawn and no tile request
// starts; once shown the camera is where the movement ends, the flight has completed without replaying its frames,
// and the view's tiles refresh to full detail.
import { expect, test, type Page } from '@playwright/test';
import { openGlobe, waitForIdle } from '../support/globe.ts';
import { lifecycleControls } from './support/page-clock.ts';
import { collectErrors, unexpected } from './support/probes.ts';

test.use({ viewport: { width: 320, height: 240 } });

const BACKENDS = ['webgpu', 'webgl2'] as const;
const DESTINATION = { longitudeDeg: 2.35, latitudeDeg: 48.85, zoom: 7, headingDeg: 0, tiltDeg: 0 };
/** The real time the tab stays hidden; the clock jumps by the simulated time meanwhile. */
const HIDDEN_REAL_MS = 2000;

/** Hides the page for `HIDDEN_REAL_MS`, moving its clock on by `simulatedMs`; returns what happened meanwhile. */
async function hideFor(page: Page, simulatedMs: number) {
  const requests: string[] = [];
  const record = (request: { url: () => string }): void => void requests.push(request.url());
  const { before, camera } = await page.evaluate((ms) => {
    (window as unknown as { setHidden: (h: boolean, j: number) => void }).setHidden(true, ms);
    return {
      before: window.vibeglobePlayground?.globe.frameNumber ?? 0,
      camera: window.vibeglobePlayground?.globe.camera,
    };
  }, simulatedMs);
  // Requests already started before hiding may still be reported: only those starting after a short grace count.
  await page.waitForTimeout(100);
  page.on('request', record);
  await page.waitForTimeout(HIDDEN_REAL_MS);
  page.off('request', record);
  const frames = (await page.evaluate(() => window.vibeglobePlayground?.globe.frameNumber ?? 0)) - before;
  return { frames, requests: requests.filter((url) => url.includes('/fixture-tiles/')), camera };
}

/**
 * Shows the page; returns the camera two animation frames later (the engine draws on the first) and the frames drawn
 * until the engine is idle again.
 */
async function show(page: Page) {
  const before = await page.evaluate(async () => {
    (window as unknown as { setHidden: (h: boolean) => void }).setHidden(false);
    const frame = window.vibeglobePlayground?.globe.frameNumber ?? 0;
    for (let i = 0; i < 2; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
    return { frame, camera: window.vibeglobePlayground?.globe.camera };
  });
  return { firstCamera: before.camera, frames: (await waitForIdle(page)) - before.frame };
}

/** Waits until the view's imagery has loaded at full detail. */
async function expectFreshTiles(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const globe = window.vibeglobePlayground?.globe;
          globe?.requestRender();
          const imagery = globe?.imageryStats();
          const pending = imagery ? imagery.queued + imagery.loading + imagery.decoding + imagery.uploadsPending : -1;
          return { pending, fromAncestor: globe?.surfaceStats().fromAncestor };
        }),
      { timeout: 60_000 },
    )
    .toEqual({ pending: 0, fromAncestor: 0 });
}

for (const backend of BACKENDS) {
  for (const minutes of [1, 10]) {
    test(`hidden for ${minutes} min during a flight on ${backend}: no frame or request while hidden, the flight completed on return without replaying, tiles refreshed (F515)`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      const errors = await collectErrors(page);
      await page.addInitScript(lifecycleControls);
      await openGlobe(page, `backend=${backend}&imagery=world&lon=12.5&lat=41.9&zoom=6`);
      await page.evaluate((target) => {
        const globe = window.vibeglobePlayground?.globe;
        const w = window as unknown as { outcome?: string };
        void globe?.flyTo(target, { durationMs: 4000 }).then((outcome) => (w.outcome = outcome));
      }, DESTINATION);
      // Halfway through the flight.
      await page.waitForTimeout(1500);
      expect(await page.evaluate(() => (window as unknown as { outcome?: string }).outcome)).toBeUndefined();
      const { camera: hiddenAt, ...hidden } = await hideFor(page, minutes * 60_000);
      expect(hidden).toEqual({ frames: 0, requests: [] });
      const { firstCamera, frames } = await show(page);
      // On return the flight either ends at once or resumes where it stopped: no jump and no replay of its frames.
      const atEnd = Math.abs((firstCamera?.longitudeDeg ?? NaN) - DESTINATION.longitudeDeg) < 1e-6;
      // Resumed: the first frame continues from where the flight stopped, short of half the way left (a jump in
      // proportion to the hidden minutes would reach the end).
      const left = Math.abs(DESTINATION.longitudeDeg - (hiddenAt?.longitudeDeg ?? NaN));
      const resumed = Math.abs((firstCamera?.longitudeDeg ?? NaN) - (hiddenAt?.longitudeDeg ?? NaN)) < left / 2;
      console.log(`[robustness] F515 flight ${minutes} min ${backend}: ${JSON.stringify({ hiddenAt, firstCamera })}`);
      expect(atEnd || resumed).toBe(true);
      // And completes at its destination.
      expect(await page.evaluate(() => (window as unknown as { outcome?: string }).outcome)).toBe('completed');
      const camera = await page.evaluate(() => window.vibeglobePlayground?.globe.camera);
      expect(camera?.longitudeDeg).toBeCloseTo(DESTINATION.longitudeDeg, 6);
      expect(camera?.latitudeDeg).toBeCloseTo(DESTINATION.latitudeDeg, 6);
      expect(camera?.zoom).toBeCloseTo(DESTINATION.zoom, 6);
      console.log(`[robustness] F515 flight ${minutes} min ${backend}: ${frames} frames until idle after showing`);
      await expectFreshTiles(page);
      expect(unexpected(errors)).toEqual([]);
    });

    test(`hidden for ${minutes} min while idle on ${backend}: no frame or request while hidden, the same camera and fresh tiles on return (F515)`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      const errors = await collectErrors(page);
      await page.addInitScript(lifecycleControls);
      await openGlobe(page, `backend=${backend}&imagery=world&lon=12.5&lat=41.9&zoom=7`);
      await expectFreshTiles(page);
      await waitForIdle(page);
      const before = await page.evaluate(() => window.vibeglobePlayground?.globe.camera);
      const { frames: hiddenFrames, requests } = await hideFor(page, minutes * 60_000);
      expect({ hiddenFrames, requests }).toEqual({ hiddenFrames: 0, requests: [] });
      const { frames } = await show(page);
      // Drawn again on return, without an animation burst.
      expect(frames).toBeGreaterThan(0);
      expect(frames).toBeLessThan(30);
      expect(await page.evaluate(() => window.vibeglobePlayground?.globe.camera)).toEqual(before);
      await expectFreshTiles(page);
      expect(unexpected(errors)).toEqual([]);
    });
  }
}
