import { expect, test } from '@playwright/test';
import { openGlobe, waitForIdle } from './support/globe.ts';
import { waitForImagery } from './support/imagery.ts';
import { captureCanvas, compareImages, CROSS_BACKEND, expectMatchesBaseline, viewName } from './support/visual.ts';

const BACKENDS = ['webgpu', 'webgl2'] as const;

/**
 * Canonical views (ADR 0012): the globe, a region, a pole, the antimeridian, both street-level scenarios, and minified
 * imagery.
 */
const VIEWS: readonly { name: string; query: string; drawCalls?: number; imagery?: boolean; crossBackend?: false }[] = [
  { name: 'orbit', query: 'lon=-30&lat=20&zoom=1.5' },
  { name: 'europe', query: 'lon=12&lat=45&zoom=4' },
  { name: 'north-pole', query: 'lon=0&lat=85&zoom=2' },
  { name: 'antimeridian', query: 'lon=180&lat=-15&zoom=3' },
  { name: 'street-pattern', query: 'scenario=street-level-jitter&lon=9.19&lat=45.46&zoom=25.5', drawCalls: 2 },
  { name: 'depth-range', query: 'scenario=depth-range&lon=9.19&lat=45.46&zoom=24.9&tilt=80', drawCalls: 100 },
  // One-texel stripes, minified toward the horizon: mipmapped, they fade to an even gray without moiré (F107). Each
  // backend has its own baseline; across backends the pixels on tile seams differ, because texture derivatives at a
  // triangle edge are implementation-defined and one-texel stripes turn that into a full-contrast change (test-changes).
  {
    name: 'stripes-minified',
    query: 'imagery=stripes&session=visual&lon=12.5&lat=41.9&zoom=6&tilt=70',
    imagery: true,
    crossBackend: false,
  },
];

test.use({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });

for (const backend of BACKENDS) {
  for (const view of VIEWS) {
    test(`canonical view ${view.name} matches its baseline on ${backend} (F072, F074)`, async ({ page }, testInfo) => {
      await openGlobe(page, `backend=${backend}&${view.query}`);
      if (view.drawCalls !== undefined) {
        await page.waitForFunction(
          (min) => (window.vibeglobePlayground?.globe.rendererStats().drawCalls ?? 0) >= min,
          view.drawCalls,
        );
      }
      // Tiled imagery streams in after the first idle frame: capture only once every tile shows its own level.
      if (view.imagery) await waitForImagery(page);
      await waitForIdle(page);
      await expectMatchesBaseline(page, testInfo, viewName(backend, view.name), await captureCanvas(page));
    });
  }
}

for (const view of VIEWS.filter((v) => v.crossBackend !== false)) {
  test(`canonical view ${view.name} looks the same on WebGPU and WebGL2 (F073)`, async ({ page }, testInfo) => {
    const captures = [];
    for (const backend of BACKENDS) {
      await openGlobe(page, `backend=${backend}&${view.query}`);
      if (view.drawCalls !== undefined) {
        await page.waitForFunction(
          (min) => (window.vibeglobePlayground?.globe.rendererStats().drawCalls ?? 0) >= min,
          view.drawCalls,
        );
      }
      // Tiled imagery streams in after the first idle frame: capture only once every tile shows its own level.
      if (view.imagery) await waitForImagery(page);
      await waitForIdle(page);
      captures.push(await captureCanvas(page));
    }
    const [webgpu, webgl2] = captures;
    if (!webgpu || !webgl2) throw new Error('missing capture');
    const result = compareImages(webgpu, webgl2, CROSS_BACKEND.threshold);
    await testInfo.attach(`${view.name}-backend-diff`, {
      body: (await import('pngjs')).PNG.sync.write(result.diff),
      contentType: 'image/png',
    });
    expect(result.ratio, `${result.differing} pixels differ between backends`).toBeLessThanOrEqual(
      CROSS_BACKEND.maxDiffRatio,
    );
  });
}

for (const backend of BACKENDS) {
  test(`renders crisply at device pixel ratios 1, 1.5 and 2 on ${backend} (F071)`, async ({ page }, testInfo) => {
    await openGlobe(page, `backend=${backend}&lon=12&lat=45&zoom=4`);
    const session = await page.context().newCDPSession(page);
    for (const ratio of [1, 2, 1.5]) {
      await session.send('Emulation.setDeviceMetricsOverride', {
        width: 960,
        height: 540,
        deviceScaleFactor: ratio,
        mobile: false,
      });
      await page.waitForFunction((r) => window.devicePixelRatio === r, ratio);
      await page.evaluate(() => window.vibeglobePlayground?.globe.requestRender());
      await waitForIdle(page);
      const size = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>('#globe');
        return { backing: [canvas?.width, canvas?.height], css: [canvas?.clientWidth, canvas?.clientHeight] };
      });
      // The backing store follows the pixel ratio times the resolution scale (1 here).
      expect(size.backing).toEqual(size.css.map((value) => Math.round((value ?? 0) * ratio)));
      await expectMatchesBaseline(
        page,
        testInfo,
        viewName(backend, 'europe', `-dpr${ratio}`),
        await captureCanvas(page),
      );
    }
  });
}
