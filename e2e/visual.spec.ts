import { expect, test } from '@playwright/test';
import { openGlobe, waitForIdle } from './support/globe.ts';
import { waitForImagery, waitForStreaming } from './support/imagery.ts';
import { captureCanvas, compareImages, CROSS_BACKEND, expectMatchesBaseline, viewName } from './support/visual.ts';

const BACKENDS = ['webgpu', 'webgl2'] as const;

/**
 * Canonical views (ADR 0012): the globe, a region, a pole, the antimeridian, both street-level scenarios, minified
 * imagery and terrain.
 */
const VIEWS: readonly {
  name: string;
  query: string;
  drawCalls?: number;
  imagery?: boolean;
  crossBackend?: false;
  /** Streams for longer than the default 60 s on the software GPU (docs/internal/test-changes.md). */
  slow?: true;
  /** Device pixel ratio of the capture (default 1). */
  dpr?: number;
  /** Waits for every request to settle instead: geographic imagery shows other levels than the surface tiles'. */
  streaming?: true;
}[] = [
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
  // Tilted relief of the fixture terrain in each built-in encoding, under the `world` fixture imagery (F127, F129,
  // F130). Each backend has its own baseline: `world`'s one-pixel grid lines lie on tile seams, whose pixels differ
  // across backends as stripes-minified's do (test-changes); terrain-smooth compares the relief across backends.
  { name: 'terrain-terrarium', query: 'scenario=terrain-terrarium&session=visual', imagery: true, crossBackend: false },
  { name: 'terrain-rgb', query: 'scenario=terrain-rgb&session=visual', imagery: true, crossBackend: false },
  {
    name: 'terrain-quantized-mesh',
    query: 'scenario=terrain-quantized-mesh&session=visual',
    imagery: true,
    crossBackend: false,
    slow: true,
  },
  { name: 'terrain-smooth', query: 'scenario=terrain-terrarium&imagery=smooth&session=visual', imagery: true },
  // M5's phases in Auto mode: the globe (F151), the flat 2D map at city scale (F153) and the tilted street view with
  // relief (F154). Grid lines on tile seams differ across backends, as for stripes-minified (test-changes).
  { name: 'globe-world', query: 'scenario=globe-world&session=visual', imagery: true, crossBackend: false },
  { name: 'map-2d-city', query: 'scenario=map-2d-city&session=visual', imagery: true, crossBackend: false },
  {
    name: 'street-tilted',
    query: 'scenario=zoom-city-to-street&zoom=17&session=visual',
    imagery: true,
    crossBackend: false,
  },
  // Inside the tilt band, where tilt and relief are still rising (F154).
  {
    name: 'street-tilt-15',
    query: 'scenario=zoom-city-to-street&zoom=15&session=visual',
    imagery: true,
    crossBackend: false,
  },
  {
    name: 'street-tilt-16',
    query: 'scenario=zoom-city-to-street&zoom=16&session=visual',
    imagery: true,
    crossBackend: false,
  },
  // Geodesic circles and an ellipse from the data layers in each phase (F356); edges are antialiased per backend.
  { name: 'data-circles-globe', query: 'scenario=data-circles&lon=15&lat=40&zoom=1.5', crossBackend: false },
  {
    name: 'data-circles-2d',
    query: 'scenario=data-circles&viewMode=2d&lon=10&lat=60&zoom=5.2',
    crossBackend: false,
  },
  // Marker images with anchors, sizes, rotations and offsets, crisp at device pixel ratios 1 and 2 (F352).
  { name: 'data-markers', query: 'scenario=data-markers&viewMode=2d&lon=13.3&lat=41.3&zoom=7', crossBackend: false },
  {
    name: 'data-markers-dpr2',
    query: 'scenario=data-markers&viewMode=2d&lon=13.3&lat=41.3&zoom=7',
    crossBackend: false,
    dpr: 2,
  },
  // Labels in several scripts, fonts, sizes, colors, halos, anchors and offsets (F357).
  { name: 'data-labels', query: 'scenario=data-labels&viewMode=2d&lon=18.5&lat=43.8&zoom=5', crossBackend: false },
  {
    name: 'data-circles-tilted',
    query: 'scenario=data-circles&viewMode=3d&lon=10&lat=60&zoom=5.2&tilt=40',
    crossBackend: false,
  },
  // Tile placement of both tiling schemes (F224, F225): the views of e2e/imagery-tiling.spec.ts, whose grid lines
  // land within half a pixel of their projected positions. Grid lines on tile seams differ across backends.
  ...[
    ['mercator-globe', 'mercator', 'lon=10&lat=30&zoom=2&imageryMax=2&level=4'],
    ['mercator-2d', 'mercator', 'viewMode=2d&lon=10&lat=50&zoom=5&imageryMax=5'],
    ['mercator-3d', 'mercator', 'viewMode=3d&lon=10&lat=45&zoom=6&tilt=40&imageryMax=5'],
    ['geographic-antimeridian', 'geographic', 'lon=180&lat=10&zoom=2.3&imageryMax=1&level=4'],
    ['geographic-north', 'geographic', 'lon=30&lat=88&zoom=2.3&imageryMax=1&level=4'],
    ['geographic-south', 'geographic', 'lon=-150&lat=-88&zoom=2.3&imageryMax=1&level=4'],
    ['geographic-2d', 'geographic', 'viewMode=2d&lon=180&lat=40&zoom=5.3'],
  ].map(([name, tiling, query]) => ({
    name: `tiling-${name}`,
    query: `imagery=world&imageryTiling=${tiling}&session=visual&${query}`,
    crossBackend: false as const,
    streaming: true as const,
  })),
];

test.use({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });

/** One log line per view stage with the seconds since the view started, so a slow or stuck stage shows in CI logs. */
function stageLog(view: string): (stage: string) => void {
  const start = Date.now();
  return (stage) => console.log(`[visual] ${view}: ${stage} after ${((Date.now() - start) / 1000).toFixed(1)} s`);
}

for (const backend of BACKENDS) {
  for (const view of VIEWS) {
    test(`canonical view ${view.name} matches its baseline on ${backend} (F072, F074)`, async ({ page }, testInfo) => {
      // Tiled imagery streams about 120 tiles before the capture, beyond 30 s on CI's software WebGPU.
      if (view.imagery || view.streaming) test.setTimeout(view.slow ? 180_000 : 90_000);
      const stages = stageLog(`${backend} ${view.name}`);
      if (view.dpr !== undefined)
        await (
          await page.context().newCDPSession(page)
        ).send('Emulation.setDeviceMetricsOverride', {
          width: 960,
          height: 540,
          deviceScaleFactor: view.dpr,
          mobile: false,
        });
      await openGlobe(page, `backend=${backend}&${view.query}`);
      stages('opened');
      if (view.drawCalls !== undefined) {
        await page.waitForFunction(
          (min) => (window.vibeglobePlayground?.globe.rendererStats().drawCalls ?? 0) >= min,
          view.drawCalls,
        );
      }
      // Tiled imagery streams in after the first idle frame: capture only once every tile shows its own level.
      if (view.imagery) await waitForImagery(page, view.slow ? 150_000 : 60_000);
      if (view.streaming) await waitForStreaming(page);
      stages('imagery');
      await waitForIdle(page);
      stages('idle');
      // A settled view: a second capture after the next idle shows the same pixels (KB-203: on CI the engine has gone
      // idle before data-layer labels were drawn, about one first attempt in two for data-labels and data-markers).
      let capture = await captureCanvas(page);
      for (let attempt = 0; attempt < 5; attempt++) {
        await page.waitForTimeout(300);
        await waitForIdle(page);
        const again = await captureCanvas(page);
        if (compareImages(capture, again, 0).differing === 0) break;
        capture = again;
      }
      stages('captured');
      await expectMatchesBaseline(page, testInfo, viewName(backend, view.name), capture);
    });
  }
}

for (const view of VIEWS.filter((v) => v.crossBackend !== false)) {
  test(`canonical view ${view.name} looks the same on WebGPU and WebGL2 (F073)`, async ({ page }, testInfo) => {
    // Two captures, each streaming its tiles (up to about 40 s each on CI's software WebGPU; test-changes).
    if (view.imagery) test.setTimeout(150_000);
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
