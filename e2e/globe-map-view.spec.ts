import { expect, test, type Page } from '@playwright/test';
import { canvasImage, geoToScreen, nextFrame, openGlobe, screenToGeo, waitForIdle } from './support/globe.ts';
import { hardwareGpu } from '../scripts/browser/gpu-args.ts';
import type { ScenarioReport } from './support/globe.ts';

/**
 * M5: the globe-to-flat morph, the zoom curves and the view modes (ADR 0008, ADR 0034) on both backends. Frame-stepped
 * scenarios run on a manual clock and a 320 × 240 canvas (CLAUDE.md, Working efficiently).
 */
const BACKENDS = ['webgpu', 'webgl2'] as const;
const CLOCK = 'clockStepMs=16.666666666666668';
const DEG = Math.PI / 180;

test.use({ viewport: { width: 320, height: 240 } });

/** The Auto curves' defaults (docs/plan/m5-globe-map-3d.md, ADR 0008), re-derived here, not read from the engine. */
function smootherstep(start: number, end: number, x: number): number {
  const t = x <= start ? 0 : x >= end ? 1 : (x - start) / (end - start);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Ground zoom of a Web Mercator zoom at a latitude: the zoom the curves read. */
function groundZoom(zoom: number, latitudeDeg: number): number {
  return zoom - Math.log2(Math.cos(latitudeDeg * DEG));
}

/** Plays a frame-stepped scenario of the playground and returns its report. */
async function record(page: Page, query: string, scenario: string): Promise<ScenarioReport> {
  await openGlobe(page, `${CLOCK}&${query}`);
  const report = await page.evaluate((name) => window.vibeglobePlayground?.recordScenario(name), scenario);
  if (!report) throw new Error('no report');
  return report;
}

/** The camera's tilt and mode, read after the next frame. */
async function cameraAfterFrame(page: Page): Promise<{ tiltDeg: number; chosenTiltDeg: number; viewMode: string }> {
  await nextFrame(page);
  return page.evaluate(() => {
    const camera = window.vibeglobePlayground?.globe.camera;
    if (!camera) throw new Error('no globe');
    return { tiltDeg: camera.tiltDeg, chosenTiltDeg: camera.chosenTiltDeg, viewMode: camera.viewMode };
  });
}

for (const backend of BACKENDS) {
  test.describe(backend, () => {
    test(`a continuous zoom from the globe to the street follows the Auto curves, phase by phase, without a jump on ${backend} (F548, F151, F153, F154, F161)`, async ({
      page,
    }) => {
      test.setTimeout(240_000);
      const report = await record(page, `backend=${backend}`, 'zoom-globe-to-street');
      // Every frame: the reported morph, relief and tilt are the curves' values at its ground zoom (Rome, 41.9° N).
      for (const [zoom, morph, relief, tiltDeg, mode, phase] of report.samples) {
        const z = groundZoom(zoom, 41.9);
        expect(mode).toBe('auto');
        expect(morph).toBeCloseTo(smootherstep(4, 6.5, z), 9);
        expect(tiltDeg).toBeCloseTo(50 * smootherstep(14, 16.5, z), 6);
        expect(relief).toBeCloseTo(Math.max(smootherstep(10, 15, z), smootherstep(0, 30, tiltDeg)), 6);
        // The phases of the plan's table.
        const expected = morph <= 0 ? 'globe' : morph < 1 ? 'flattening' : z < 14 ? '2d' : '3d';
        expect(phase).toBe(expected);
        if (phase === 'globe') expect([tiltDeg, relief]).toEqual([0, 0]);
        if (phase === '2d') expect([morph, tiltDeg]).toEqual([1, 0]);
      }
      const phases = new Set(report.samples.map((sample) => sample[5]));
      expect([...phases]).toEqual(['globe', 'flattening', '2d', '3d']);
      // The tilt rises only in the 3D phase, monotonically, to the automatic tilt; relief reaches full height.
      const tilts = report.samples.map((sample) => sample[3]);
      expect(tilts.every((tilt, i) => i === 0 || tilt >= (tilts[i - 1] ?? 0) - 1e-9)).toBe(true);
      expect(tilts.at(-1)).toBeCloseTo(50, 6);
      expect(report.samples.at(-1)?.[2]).toBe(1);
      expect(report.holes).toBe(0);
      // No frame jumps: in 0.1-zoom steps, few pixels change by more than a quarter of their range.
      console.log(
        `zoom-globe-to-street ${backend}: largest changed share ${report.maxChangedShare.toFixed(3)} at frame ${report.maxChangedFrame}`,
      );
      expect(report.maxChangedShare).toBeLessThan(0.25);
    });

    test(`the morph sweeps from the globe to the flat map and back with no geometry upload and no jump on ${backend} (F152)`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await openGlobe(page, `${CLOCK}&backend=${backend}&lon=12.5&lat=41.9&zoom=3`);
      // A first sweep loads every tile the sweep shows; the second must upload no geometry: the morph moves vertices
      // on the GPU.
      await page.evaluate(() => window.vibeglobePlayground?.recordScenario('morph-sweep'));
      const before = await page.evaluate(() => window.vibeglobePlayground?.globe.rendererStats().meshUploads ?? -1);
      const report = await page.evaluate(() => window.vibeglobePlayground?.recordScenario('morph-sweep'));
      if (!report) throw new Error('no report');
      const after = await page.evaluate(() => window.vibeglobePlayground?.globe.rendererStats().meshUploads ?? -1);
      expect(after - before).toBe(0);
      const morphs = report.samples.map((sample) => sample[1]);
      expect(Math.min(...morphs)).toBe(0);
      expect(Math.max(...morphs)).toBe(1);
      expect(report.holes).toBe(0);
      console.log(
        `morph-sweep ${backend}: largest changed share ${report.maxChangedShare.toFixed(3)} at frame ${report.maxChangedFrame}`,
      );
      expect(report.maxChangedShare).toBeLessThan(0.25);
    });

    test(`polar caps stay covered through the morph and the tilt near both poles on ${backend} (F160)`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      const report = await record(page, `backend=${backend}&lon=30&lat=80&zoom=3`, 'morph-poles');
      expect([report.holes, report.firstHoleFrame]).toEqual([0, -1]);
    });

    test(`wheel zoom keeps the point under the cursor through the flattening band, at the center, the corners and near the limb, turned on ${backend} (F155)`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      for (const [x, y] of [
        [160, 120],
        [20, 20],
        [300, 220],
        [160, 20],
      ] as const) {
        await openGlobe(page, `backend=${backend}&lon=12.5&lat=41.9&zoom=3.6&heading=30`);
        const box = await page.locator('#globe').boundingBox();
        if (!box) throw new Error('no canvas');
        const grabbed = await screenToGeo(page, { xPx: x, yPx: y });
        if (!grabbed) throw new Error(`(${x}, ${y}) is off the globe`);
        await page.mouse.move(box.x + x, box.y + y);
        // Through the whole flattening band (ground zoom 4 to 6.5 at 41.9° N: zoom 3.6 to 6.2).
        for (let step = 0; step < 14; step++) {
          await page.mouse.wheel(0, -100);
          await nextFrame(page);
          await nextFrame(page);
          const shown = await geoToScreen(page, grabbed);
          expect(Math.hypot(shown.xPx - x, shown.yPx - y), `step ${step} at (${x}, ${y})`).toBeLessThan(1);
        }
        const morph = await page.evaluate(() => window.vibeglobePlayground?.globe.camera.morphFactor ?? -1);
        expect(morph).toBe(1);
      }
    });

    test(`an API zoom through the morph keeps the screen center's point at the center on ${backend} (F156)`, async ({
      page,
    }) => {
      await openGlobe(page, `backend=${backend}&lon=-70&lat=-20&zoom=3`);
      const center = await screenToGeo(page, { xPx: 160, yPx: 120 });
      if (!center) throw new Error('no center');
      for (let zoom = 3; zoom <= 7.5; zoom += 0.25) {
        await page.evaluate((z) => window.vibeglobePlayground?.globe.jumpTo({ zoom: z }), zoom);
        await nextFrame(page);
        const shown = await geoToScreen(page, center);
        expect(Math.hypot(shown.xPx - 160, shown.yPx - 120), `zoom ${zoom}`).toBeLessThan(1);
      }
    });

    test(`picked positions and their distances are the same in every phase on ${backend} (F158)`, async ({ page }) => {
      const points = [
        // About 20 m apart: both on screen from the globe to the street.
        { longitudeDeg: 12.4999, latitudeDeg: 41.8999 },
        { longitudeDeg: 12.5001, latitudeDeg: 41.9001 },
      ];
      const distances: number[] = [];
      for (const [view, phase] of [
        ['zoom=3', 'globe'],
        ['zoom=5', 'flattening'],
        ['zoom=9', '2d'],
        ['zoom=12&tilt=50', '2d'],
        ['zoom=16', '3d'],
      ] as const) {
        await openGlobe(page, `backend=${backend}&lon=12.5&lat=41.9&${view}`);
        expect(await page.evaluate(() => window.vibeglobePlayground?.globe.camera.phase), view).toBe(phase);
        const picks: { longitudeDeg: number; latitudeDeg: number }[] = [];
        for (const point of points) {
          const shown = await geoToScreen(page, point);
          const picked = await screenToGeo(page, shown);
          if (!picked) throw new Error(`${JSON.stringify(point)} not picked back in ${view}`);
          expect(Object.keys(picked).sort()).toEqual(['heightMeters', 'latitudeDeg', 'longitudeDeg']);
          // Within a hundredth of a pixel's ground size in every phase: the pick inverts the drawn morph.
          expect(Math.abs(picked.longitudeDeg - point.longitudeDeg)).toBeLessThan(1e-7);
          expect(Math.abs(picked.latitudeDeg - point.latitudeDeg)).toBeLessThan(1e-7);
          picks.push(picked);
        }
        // The geodesic distance between the picked points, through the core API: the same in every phase.
        const [from, to] = picks;
        if (!from || !to) throw new Error('two picks');
        distances.push(
          await page.evaluate(([a, b]) => window.vibeglobePlayground?.geodesicDistanceMeters(a, b) ?? NaN, [
            from,
            to,
          ] as const),
        );
      }
      // Picks agree within 1e-7°, about a centimeter: the distances within 5 cm.
      for (const distance of distances) expect(distance).toBeCloseTo(distances[0] ?? NaN, 1);
      expect(distances[0]).toBeGreaterThan(20);
    });

    test(`2D locks the tilt at 0° at every zoom while the morph follows the zoom, and keeps the heading on ${backend} (F162)`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      // A fixed 60 Hz engine clock: the animation runs on engine time (KB-099), so a slow frame here would be a bigger step.
      await openGlobe(page, `backend=${backend}&lon=12.5&lat=41.9&zoom=17&clockStepMs=16.666666666666668`);
      expect((await cameraAfterFrame(page)).tiltDeg).toBeGreaterThan(40);
      // The tilt animates to 0°: every drawn frame lower, none by more than a third of the way (recorded per frame in
      // the page: several frames can pass between two round trips on a slow GPU).
      const tilts = await page.evaluate(
        () =>
          new Promise<number[]>((resolve) => {
            const globe = window.vibeglobePlayground?.globe;
            if (!globe) throw new Error('no globe');
            const recorded = [globe.camera.tiltDeg];
            const off = globe.on('camera-change', ({ tiltDeg }) => {
              recorded.push(tiltDeg);
              if (tiltDeg === 0 || recorded.length > 60) {
                off();
                resolve(recorded);
              }
            });
            globe.setViewMode('2d');
          }),
      );
      let previous = tilts[0] ?? NaN;
      for (const tilt of tilts.slice(1)) {
        expect(tilt).toBeLessThanOrEqual(previous);
        expect(previous - tilt).toBeLessThan(15);
        previous = tilt;
      }
      expect(previous).toBe(0);
      await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ headingDeg: 35 }));
      // Wheel zoom from the street out to the globe and back in, every drawn frame recorded in the page.
      await page.evaluate(() => {
        const globe = window.vibeglobePlayground?.globe;
        if (!globe) throw new Error('no globe');
        const frames: number[][] = [];
        (window as unknown as { lockedFrames: number[][] }).lockedFrames = frames;
        globe.on('camera-change', (c) => frames.push([c.zoom, c.latitudeDeg, c.tiltDeg, c.headingDeg, c.morphFactor]));
      });
      const box = await page.locator('#globe').boundingBox();
      if (!box) throw new Error('no canvas');
      await page.mouse.move(box.x + 160, box.y + 120);
      const zoomNow = (): Promise<number> => page.evaluate(() => window.vibeglobePlayground?.globe.camera.zoom ?? NaN);
      for (let step = 0; step < 120 && (await zoomNow()) > 2.5; step++) {
        await page.mouse.wheel(0, 400);
        await nextFrame(page);
      }
      for (let step = 0; step < 120 && (await zoomNow()) < 16; step++) {
        await page.mouse.wheel(0, -400);
        await nextFrame(page);
      }
      const frames = await page.evaluate(() => (window as unknown as { lockedFrames: number[][] }).lockedFrames);
      const zooms = frames.map((frame) => frame[0] ?? NaN);
      expect(Math.min(...zooms)).toBeLessThan(3);
      expect(Math.max(...zooms.slice(zooms.indexOf(Math.min(...zooms))))).toBeGreaterThan(15.5);
      for (const [zoom = NaN, latitude = NaN, tilt, heading, morph] of frames) {
        expect(tilt, `zoom ${zoom}`).toBe(0);
        expect(heading).toBeCloseTo(35, 6);
        expect(morph, `zoom ${zoom}`).toBeCloseTo(smootherstep(4, 6.5, groundZoom(zoom, latitude)), 9);
      }
    });

    test(`the 2D, 3D and Auto buttons and the API set the mode and tilt, animating, with mode events on ${backend} (F163)`, async ({
      page,
    }) => {
      // The engine clock steps 1/60 s per frame: per-frame steps of the eased tilt are then those of a 60 Hz display.
      await openGlobe(page, `${CLOCK}&backend=${backend}&lon=12.5&lat=41.9&zoom=12`);
      const buttons = page.locator('#view-modes button');
      await expect(buttons).toHaveText(['2D', '3D', 'Auto']);
      await expect(page.locator('#view-modes button[data-mode="auto"]')).toBeVisible();
      await expect(page.locator('#view-modes button[aria-pressed="true"]')).toHaveText('Auto');
      await page.evaluate(() => {
        const events: string[] = [];
        window.vibeglobePlayground?.globe.on('view-mode-change', ({ mode }) => events.push(mode));
        (window as unknown as { modeEvents: string[] }).modeEvents = events;
      });
      for (const [label, mode, tilt] of [
        ['3D', 'manual', 50],
        ['2D', '2d', 0],
        ['Auto', 'auto', 0],
      ] as const) {
        await page.locator('#view-modes button', { hasText: label }).click();
        let previous = (await cameraAfterFrame(page)).tiltDeg;
        for (let i = 0; i < 40; i++) {
          const camera = await cameraAfterFrame(page);
          expect(Math.abs(camera.tiltDeg - previous)).toBeLessThan(15);
          previous = camera.tiltDeg;
        }
        const camera = await cameraAfterFrame(page);
        expect([camera.viewMode, camera.tiltDeg]).toEqual([mode, tilt]);
        if (label === '3D') expect(camera.chosenTiltDeg).toBeCloseTo(50, 9);
        await expect(page.locator('#view-modes button[aria-pressed="true"]')).toHaveText(label);
      }
      // The API gives the same results and the same events.
      await page.evaluate(() => window.vibeglobePlayground?.globe.setViewMode('3d'));
      expect(await page.evaluate(() => window.vibeglobePlayground?.globe.viewMode)).toBe('manual');
      expect(await page.evaluate(() => (window as unknown as { modeEvents: string[] }).modeEvents)).toEqual([
        'manual',
        '2d',
        'auto',
        'manual',
      ]);
      // From a manual tilt at street zoom, Auto brings the curve's tilt back without a jump, then follows the curves.
      // A manual 0° far from the curve's 50°: the way back to Auto is long enough for a jump to show.
      await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ zoom: 17, tiltDeg: 0 }));
      await waitForIdle(page);
      expect((await cameraAfterFrame(page)).viewMode).toBe('manual');
      const tilts = await page.evaluate(
        () =>
          new Promise<number[]>((resolve) => {
            const globe = window.vibeglobePlayground?.globe;
            if (!globe) throw new Error('no globe');
            const recorded = [globe.camera.tiltDeg];
            const off = globe.on('camera-change', ({ tiltDeg }) => {
              recorded.push(tiltDeg);
              if (Math.abs(tiltDeg - 50) < 1e-6 || recorded.length > 80) {
                off();
                resolve(recorded);
              }
            });
            globe.setViewMode('auto');
          }),
      );
      expect(tilts.at(-1)).toBeCloseTo(50, 6);
      for (let i = 1; i < tilts.length; i++) {
        expect(tilts[i] ?? NaN).toBeGreaterThanOrEqual(tilts[i - 1] ?? NaN);
        expect((tilts[i] ?? NaN) - (tilts[i - 1] ?? NaN)).toBeLessThan(15);
      }
      expect(tilts.length).toBeGreaterThan(4);
      for (const zoom of [15.5, 14.8]) {
        await page.evaluate((z) => window.vibeglobePlayground?.globe.jumpTo({ zoom: z }), zoom);
        await waitForIdle(page);
        const camera = await cameraAfterFrame(page);
        expect([camera.viewMode, camera.tiltDeg]).toEqual([
          'auto',
          expect.closeTo(50 * smootherstep(14, 16.5, groundZoom(zoom, 41.9)), 6),
        ]);
      }
    });

    test(`a tilt chosen at street level is lowered while empty sky would fill the screen and comes back without a jump on ${backend} (F166)`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await openGlobe(page, `backend=${backend}&lon=12.5&lat=41.9&zoom=16&tilt=60`);
      const tilts: number[] = [];
      for (let zoom = 16; zoom >= 1; zoom -= 0.5) {
        await page.evaluate((z) => window.vibeglobePlayground?.globe.jumpTo({ zoom: z }), zoom);
        const camera = await cameraAfterFrame(page);
        expect(camera.chosenTiltDeg).toBeCloseTo(60, 9);
        tilts.push(camera.tiltDeg);
        // The empty sky: transparent rows at the top of the frame, at most the top third (and a row of rounding).
        const image = await canvasImage(page);
        let skyRows = 0;
        while (skyRows < image.height && isBackgroundRow(image, skyRows)) skyRows++;
        expect(skyRows, `zoom ${zoom}`).toBeLessThanOrEqual(Math.ceil(image.height / 3) + 1);
      }
      // Lowered gradually, never raised, while zooming out.
      expect(tilts.every((tilt, i) => i === 0 || tilt <= (tilts[i - 1] ?? 0) + 1e-9)).toBe(true);
      expect(tilts.at(-1)).toBeLessThan(55);
      // Back in: the chosen 60° returns over frames, never by a jump.
      await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ zoom: 16 }));
      let previous = (await cameraAfterFrame(page)).tiltDeg;
      for (let i = 0; i < 40; i++) {
        const tilt = (await cameraAfterFrame(page)).tiltDeg;
        expect(tilt - previous).toBeLessThan(15);
        previous = tilt;
      }
      expect(previous).toBeCloseTo(60, 6);
    });
  });
}

/** True when every pixel of a row shows the page background: nothing was drawn there. */
function isBackgroundRow(image: { width: number; data: Buffer }, row: number): boolean {
  for (let x = 0; x < image.width; x++) {
    const i = (row * image.width + x) * 4;
    if (image.data[i] !== 11 || image.data[i + 1] !== 16 || image.data[i + 2] !== 32) return false;
  }
  return true;
}

test('custom curves drive the morph, relief and tilt, and changing them at runtime moves the view without a jump (F150)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const curves = {
    morph: { startGroundZoom: 2, endGroundZoom: 3 },
    relief: { startGroundZoom: 4, endGroundZoom: 5 },
    tilt: { startGroundZoom: 6, endGroundZoom: 8 },
    autoTiltDeg: 55,
  };
  // Configured in the playground: the reported morph, relief and tilt follow the custom curves.
  await openGlobe(page, `${CLOCK}&lon=12.5&lat=41.9&zoom=2.4&curves=${encodeURIComponent(JSON.stringify(curves))}`);
  for (const zoom of [2.4, 4.4, 6.6, 7.4, 9]) {
    await page.evaluate((z) => window.vibeglobePlayground?.globe.jumpTo({ zoom: z }), zoom);
    await waitForIdle(page);
    const camera = await page.evaluate(() => window.vibeglobePlayground?.globe.camera);
    const ground = groundZoom(zoom, 41.9);
    expect(camera?.morphFactor, `zoom ${zoom}`).toBeCloseTo(smootherstep(2, 3, ground), 9);
    expect(camera?.reliefFactor, `zoom ${zoom}`).toBeCloseTo(smootherstep(4, 5, ground), 9);
    expect(camera?.tiltDeg, `zoom ${zoom}`).toBeCloseTo(55 * smootherstep(6, 8, ground), 6);
  }
  // Back to the default curves at runtime: the view eases to them over frames, with no jump in the image.
  await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ zoom: 2.4 }));
  await waitForIdle(page);
  // The image before the change, so that a jump in the first changed frame is compared too.
  let previous = await canvasImage(page);
  // The morph of every engine frame, recorded in the page: a capture draws one frame, but another one (a tile
  // arriving) can come between two captures, and a per-capture sample then spans two steps.
  await page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    const samples: number[] = [];
    (window as unknown as { morphSamples: number[] }).morphSamples = samples;
    globe?.on('frame', () => samples.push(globe.camera.morphFactor));
    globe?.setViewCurves({});
  });
  let largestShare = 0;
  for (let i = 0; i < 40; i++) {
    const image = await canvasImage(page);
    largestShare = Math.max(largestShare, changedShare(previous, image));
    previous = image;
  }
  const morphs = await page.evaluate(() => (window as unknown as { morphSamples: number[] }).morphSamples);
  expect(morphs.at(-1)).toBe(0);
  expect(morphs.every((value, i) => i === 0 || Math.abs(value - (morphs[i - 1] ?? 0)) < 0.3)).toBe(true);
  expect(morphs.filter((value, i) => i > 0 && value !== morphs[i - 1]).length).toBeGreaterThan(4);
  // The same bound as the morph sweep's (F152): no frame changes a quarter of the image by a jump-sized amount.
  expect(largestShare).toBeLessThan(0.25);
});

/** The share of pixels whose color changed by more than 64 in some channel between two frames (the harness's jump). */
function changedShare(a: { data: Buffer }, b: { data: Buffer }): number {
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4)
    for (let c = 0; c < 3; c++)
      if (Math.abs((a.data[i + c] ?? 0) - (b.data[i + c] ?? 0)) > 64) {
        changed++;
        break;
      }
  return changed / (a.data.length / 4);
}

/** The largest change of a sampled value between consecutive frames. */
function largestStep(values: number[]): number {
  let largest = 0;
  for (let i = 1; i < values.length; i++)
    largest = Math.max(largest, Math.abs((values[i] ?? 0) - (values[i - 1] ?? 0)));
  return largest;
}

for (const backend of BACKENDS) {
  for (const [mode, query] of [
    ['Auto', ''],
    ['2D-locked', '&viewMode=2d'],
    ['manual-tilt', '&tilt=45&heading=30'],
  ] as const) {
    test(`M5 acceptance: the zoom from the globe to the street is continuous and glitch-free in ${mode} mode on ${backend} (F167)`, async ({
      page,
    }) => {
      test.setTimeout(240_000);
      // With the fixture terrain: the zoom ends on the fixture peak's flank, the target on its relief (F167 step 1).
      await openGlobe(page, `${CLOCK}&backend=${backend}&terrain=terrarium${query}`);
      await page.evaluate(() => window.vibeglobePlayground?.resetCpuSamples());
      const report = await page.evaluate(() =>
        window.vibeglobePlayground?.recordScenario('zoom-globe-to-street-relief'),
      );
      if (!report) throw new Error('no report');
      const times = await page.evaluate(() => window.vibeglobePlayground?.cpuFrameTimesMs() ?? []);
      const zooms = report.samples.map((sample) => sample[0]);
      const tilts = report.samples.map((sample) => sample[3]);
      const headings = report.samples.map((sample) => sample[6]);
      // Per-frame continuity: the scenario steps 0.1 zoom levels per frame; the morph and relief curves rise by at most
      // 0.075 and 0.04 per step (smootherstep's slope of 1.875 over 2.5 and 5 levels), the tilt eases (F162, F166).
      expect(largestStep(zooms)).toBeLessThan(0.11);
      expect(largestStep(report.samples.map((sample) => sample[1]))).toBeLessThan(0.1);
      expect(largestStep(report.samples.map((sample) => sample[2]))).toBeLessThan(0.1);
      expect(largestStep(tilts)).toBeLessThan(5);
      expect(largestStep(headings)).toBe(0);
      // The eye moves smoothly too: 0.1 zoom levels a frame change its height by about 7%, the terrain under the target
      // and the clearance above it add no jump.
      const heights = report.samples.map((sample) => sample[7]);
      expect(Math.max(...heights.slice(1).map((h, i) => Math.abs(h / (heights[i] ?? h) - 1)))).toBeLessThan(0.12);
      expect(Math.max(...report.samples.map((sample) => sample[2]))).toBeGreaterThan(0.99);
      if (mode === '2D-locked') expect(Math.max(...tilts)).toBe(0);
      // The chosen tilt returns at street level, to the terrain limit's probe resolution (0.005°): the eye settles at
      // the clearance above the flank.
      if (mode === 'manual-tilt') expect(tilts.at(-1)).toBeCloseTo(45, 2);
      // The temporal glitch detector: no holes, no pops, no frame-to-frame jump of the picture.
      expect([report.holes, report.dark, report.pops]).toEqual([0, 0, 0]);
      console.log(
        `F167 ${mode} ${backend}: largest changed share ${report.maxChangedShare.toFixed(3)} at frame ${report.maxChangedFrame}`,
      );
      expect(report.maxChangedShare).toBeLessThan(0.25);
      // The frame-time budget holds on the reference desktop's GPU only (ADR 0012; F167's device steps are the owner's).
      const sorted = [...times].sort((a, b) => a - b);
      if (hardwareGpu()) expect(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toBeLessThanOrEqual(16.7);
    });
  }
}
