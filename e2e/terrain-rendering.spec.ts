import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, openGlobe, waitForIdle, type ScenarioReport } from './support/globe.ts';
import { measureShift } from './support/image.ts';
import { fixtureSession, requestLog, waitForStreaming } from './support/imagery.ts';

/**
 * Terrain rendering end to end (M4 increment 2): selection (F126), relief and depth (F135), precision (F136), cracks
 * (F137), morphing (F138), missing tiles (F139), independent levels and mixed tilings (F140, F141), culling (F142) and
 * the antimeridian and poles (F143), over the fixture tile server's analytic terrain (a 4,000 m peak at 6.86° E,
 * 45.83° N, a 1,500 m ridge along 46.5° N from 7° to 10° E, ±300 m hills everywhere).
 */

test.describe.configure({ timeout: 240_000 });
// A small canvas: the software GPU draws every checked frame, and the checks read every pixel.
test.use({ viewport: { width: 480, height: 360 } });

const BACKENDS = ['webgpu', 'webgl2'] as const;
/** The playground's engine clock at 60 Hz: fades and morphs advance one frame per drawn frame. */
const CLOCK = 'clockStepMs=16.666666666666668';
/** `smooth` fixture pixels have a channel at 50 or more: anything darker inside the globe is a gap or seam. */
const DARK_BELOW = 50;
/** The fixture terrain's source maximum level in the playground. */
const TERRAIN_MAX_LEVEL = 14;

/** Waits until no terrain tile is queued, loading, decoding or waiting for its upload, and the engine is idle. */
async function waitForTerrain(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const stats = window.vibeglobePlayground?.globe.terrainStats();
          return stats ? stats.queued + stats.loading + stats.decoding + stats.uploadsPending : -1;
        }),
      { timeout: 90_000 },
    )
    .toBe(0);
  await waitForIdle(page);
}

/** Plays a frame-stepped scenario on a fresh fixture session and returns what its detectors found. */
async function record(page: Page, query: string, scenario: string, darkBelow = 0): Promise<ScenarioReport> {
  const session = await fixtureSession(page);
  await openGlobe(page, `session=${session}&${CLOCK}&${query}`);
  const report = await page.evaluate(([name, dark]) => window.vibeglobePlayground?.recordScenario(name, dark), [
    scenario,
    darkBelow,
  ] as const);
  if (!report) throw new Error('no report');
  console.log(`${scenario} ${query}: ${JSON.stringify(report)}`);
  return report;
}

test.describe('terrain selection', () => {
  // Terrain levels only: no imagery, so each zoom step streams fewer tiles.

  test('terrain levels follow the screen-space error: finer toward the camera, never beyond the source (F126)', async ({
    page,
  }) => {
    const session = await fixtureSession(page);
    await openGlobe(page, `scenario=terrain-alps&imagery=&session=${session}&debug=1&tilt=40`);
    // About 50 km to 500 m above the peak's valley.
    for (const zoom of [9, 11, 13, 15]) {
      await page.evaluate((z) => window.vibeglobePlayground?.globe.jumpTo({ zoom: z }), zoom);
      await waitForTerrain(page);
      const tiles = await page.evaluate(() => {
        const globe = window.vibeglobePlayground?.globe;
        if (!globe) throw new Error('no globe');
        const eye = globe.camera;
        return globe.surfaceTiles().map((t) => {
          // Great-circle angle from the point under the eye to the tile's center, a proxy for its distance.
          const rad = Math.PI / 180;
          const lat = ((t.southDeg + t.northDeg) / 2) * rad;
          const lon = ((t.westDeg + t.eastDeg) / 2) * rad;
          const cos =
            Math.sin(lat) * Math.sin(eye.latitudeDeg * rad) +
            Math.cos(lat) * Math.cos(eye.latitudeDeg * rad) * Math.cos(lon - eye.longitudeDeg * rad);
          return { terrainLevel: t.terrainLevel, terrainErrorPx: t.terrainErrorPx, angle: Math.acos(Math.min(1, cos)) };
        });
      });
      const withTerrain = tiles.filter((t) => t.terrainLevel !== null);
      expect(withTerrain.length).toBe(tiles.length);
      // No tile is refined beyond the source's levels, and every tile below them meets τ_terrain (2 px).
      for (const tile of withTerrain) {
        expect(tile.terrainLevel ?? 99).toBeLessThanOrEqual(TERRAIN_MAX_LEVEL);
        if ((tile.terrainLevel ?? 0) < TERRAIN_MAX_LEVEL) expect(tile.terrainErrorPx).toBeLessThanOrEqual(2.001);
      }
      // Levels increase toward the camera: the nearest quarter of the tiles is finer than the farthest quarter.
      const byDistance = [...withTerrain].sort((a, b) => a.angle - b.angle);
      const quarter = Math.max(1, Math.floor(byDistance.length / 4));
      const mean = (list: typeof byDistance): number =>
        list.reduce((sum, t) => sum + (t.terrainLevel ?? 0), 0) / list.length;
      const near = mean(byDistance.slice(0, quarter));
      const far = mean(byDistance.slice(-quarter));
      console.log(`zoom ${zoom}: ${tiles.length} tiles, near ${near.toFixed(2)}, far ${far.toFixed(2)}`);
      expect(near).toBeGreaterThan(far);
    }
  });
});

for (const backend of BACKENDS) {
  test.describe(backend, () => {
    test(`no background shows between terrain tiles of different levels while tilting and orbiting, and no shimmer, on ${backend} (F137)`, async ({
      page,
    }) => {
      // Over `smooth` imagery: a morph moves the relief by a fraction of a pixel per frame, which only one-pixel lines
      // would turn into full-contrast changes.
      const report = await record(
        page,
        `backend=${backend}&scenario=terrain-crack-sweep&imagery=smooth`,
        'terrain-crack-sweep',
      );
      expect(report.staticFrames).toBeGreaterThan(10);
      expect([report.holes, report.pops]).toEqual([0, 0]);
    });

    test(`relief morphs between levels with no pop while zooming in and out over the Alps on ${backend} (F138)`, async ({
      page,
    }) => {
      const report = await record(page, `backend=${backend}&scenario=terrain-alps&imagery=smooth`, 'terrain-alps-zoom');
      expect(report.staticFrames).toBeGreaterThan(20);
      expect([report.holes, report.pops, report.terrainDrops]).toEqual([0, 0, 0]);
    });

    test(`delayed, missing and uncovered terrain falls back to ancestors and the ellipsoid with no hole, step or early release on ${backend} (F139)`, async ({
      page,
    }) => {
      // Terrain tiles from level 6 arrive late, one subtree is missing (404), and the source covers only part of the
      // view (west of 6.5° E is uncovered): the coverage edge crosses the zoom path.
      const session = await fixtureSession(page, [
        // The first matching rule applies: the missing subtree before the latency of every other tile.
        { source: 'terrain', minLevel: 9, maxLevel: 9, xRange: [265, 266], status: 404 },
        { source: 'terrain', minLevel: 6, latencyMs: 600 },
      ]);
      await openGlobe(
        page,
        `backend=${backend}&session=${session}&${CLOCK}&scenario=terrain-alps&imagery=smooth&terrainCoverage=alps`,
      );
      const report = (await page.evaluate(
        (dark) => window.vibeglobePlayground?.recordScenario('terrain-alps-zoom', dark),
        DARK_BELOW,
      )) as ScenarioReport;
      console.log(`missing tiles ${backend}: ${JSON.stringify(report)}`);
      expect([report.holes, report.dark, report.pops, report.terrainDrops]).toEqual([0, 0, 0, 0]);
      // Failed tiles are not retried: each 404 path was requested once.
      const failed = (await requestLog(page, session)).filter((r) => r.status === 404).map((r) => r.path);
      expect(failed.length).toBeGreaterThan(0);
      expect(new Set(failed).size).toBe(failed.length);
    });

    test(`peaks behind the horizon and at the screen edge never disappear or flicker while panning on ${backend} (F142)`, async ({
      page,
    }) => {
      const report = await record(page, `backend=${backend}&scenario=terrain-horizon-peaks`, 'terrain-horizon-pan');
      expect([report.holes, report.pops]).toEqual([0, 0]);
      // In every frame the peak rises above the ellipsoid's horizon: at least 6 px of terrain above it in a column
      // (the ±300 m hills reach about 2 px there).
      expect(report.minReliefAboveHorizonPx).toBeGreaterThanOrEqual(6);
    });

    test(`terrain has no gap or seam at the antimeridian and near both poles on ${backend} (F143)`, async ({
      page,
    }) => {
      for (const scenario of ['terrain-antimeridian', 'terrain-poles']) {
        const report = await record(page, `backend=${backend}&terrain=terrarium&imagery=smooth`, scenario, DARK_BELOW);
        expect([report.holes, report.dark]).toEqual([0, 0]);
      }
    });

    test(`terrain vertices hold still at street level and move only with the camera while orbiting on ${backend} (F136)`, async ({
      page,
    }) => {
      // About 240 tiles stream on a 320 × 240 canvas, about 55 s on the software GPU.
      test.setTimeout(120_000);
      await page.setViewportSize({ width: 320, height: 240 });
      const session = await fixtureSession(page);
      // Meter-wide stripes, 2 m above the flank of the fixture peak, looking along the slope.
      await openGlobe(page, `backend=${backend}&session=${session}&${CLOCK}&scenario=terrain-street-level`);
      await waitForTerrain(page);
      // The surface refines beyond the imagery's levels here: wait for every request to settle instead.
      await waitForStreaming(page);
      // A static hold: every frame equals the first (no vertex oscillation).
      const first = await canvasImage(page);
      let changed = 0;
      for (let frame = 0; frame < 10; frame++) {
        await page.evaluate(() => window.vibeglobePlayground?.globe.requestRender());
        changed = Math.max(changed, differingPixels(first, await canvasImage(page), 8));
      }
      expect(changed).toBe(0);
      // A slow orbit: the view turns by the same amount each frame, so consecutive frames shift alike. Around a target
      // a few meters away, 0.2° per frame moves the 320 px frame by about a quarter of a pixel.
      const shifts: { dx: number; dy: number }[] = [];
      let previous = first;
      for (let frame = 0; frame < 12; frame++) {
        await page.evaluate(() => {
          const globe = window.vibeglobePlayground?.globe;
          if (globe) globe.jumpTo({ headingDeg: globe.camera.headingDeg + 0.2 });
        });
        const next = await canvasImage(page);
        shifts.push(measureShift(previous, next));
        previous = next;
      }
      const dxs = shifts.map((s) => s.dx).sort((a, b) => a - b);
      const median = dxs[Math.floor(dxs.length / 2)] ?? 0;
      console.log(
        `orbit shifts ${backend}: ${JSON.stringify(shifts.map((s) => [+s.dx.toFixed(3), +s.dy.toFixed(3)]))}`,
      );
      expect(Math.abs(median)).toBeGreaterThan(0.05);
      for (const shift of shifts) {
        expect(Math.abs(shift.dx - median)).toBeLessThan(0.25);
        expect(Math.abs(shift.dy)).toBeLessThan(0.25);
      }
    });

    test(`rendered relief lies at the source heights: probes just above show, probes just below stay hidden, on ${backend} (F135, F148)`, async ({
      page,
    }) => {
      const session = await fixtureSession(page);
      // Hills only (±300 m) seen from above: no relief stands between the eye and a probe, so a hidden probe above the
      // surface is a depth error, not an occlusion.
      await openGlobe(
        page,
        `backend=${backend}&session=${session}&scenario=terrain-alps&lon=11&lat=44.5&zoom=12.5&tilt=0`,
      );
      await waitForTerrain(page);
      const result = await page.evaluate(probeRelief, 100);
      console.log(`relief probes ${backend}: ${JSON.stringify(result)}`);
      expect(result.points).toBe(100);
      expect(result.aboveHidden).toEqual([]);
      expect(result.belowShown).toEqual([]);
    });

    test(`detailed imagery drapes coarser terrain at full sharpness, with no seam where their tiles cross, on ${backend} (F140)`, async ({
      page,
    }) => {
      const session = await fixtureSession(page);
      await openGlobe(page, `backend=${backend}&session=${session}&${CLOCK}&scenario=independent-levels&debug=1`);
      await waitForTerrain(page);
      // Imagery stops at level 18, below the surface's levels here: wait for every request to settle instead.
      await waitForStreaming(page);
      const tiles = await page.evaluate(() => window.vibeglobePlayground?.globe.surfaceTiles() ?? []);
      const mercator = tiles.filter((t) => t.root === 'mercator');
      expect(mercator.length).toBeGreaterThan(0);
      // Terrain stops at level 10; the imagery each tile shows is its own level, beyond it, at its texel error.
      for (const tile of mercator) {
        expect(tile.terrainLevel ?? 99).toBeLessThanOrEqual(10);
        expect(tile.imageryLevel).toBe(Math.min(tile.level, 18));
        // Coarse terrain never stops imagery refining: below the imagery's deepest level every texel is sharp. At that
        // level, 10 m above the ground, texels near the eye are larger: there is no finer imagery to show.
        if ((tile.imageryLevel ?? 0) < 18) expect(tile.texelErrorPx).toBeLessThanOrEqual(1.5);
      }
      expect(Math.max(...mercator.map((t) => t.imageryLevel ?? 0))).toBeGreaterThan(12);
      // The same view without terrain selects the same imagery levels at the center (imagery-only reference).
      const withTerrain = await centerImageryLevel(page);
      await openGlobe(page, `backend=${backend}&session=${session}&${CLOCK}&scenario=independent-levels&terrain=none`);
      // Imagery stops at level 18, below the surface's levels here: wait for every request to settle instead.
      await waitForStreaming(page);
      expect(Math.abs(withTerrain - (await centerImageryLevel(page)))).toBeLessThanOrEqual(1);
      // Over `smooth` imagery, a frame has no gap or dark seam along any tile border.
      await openGlobe(
        page,
        `backend=${backend}&session=${session}&${CLOCK}&scenario=independent-levels&imagery=smooth`,
      );
      await waitForTerrain(page);
      // Imagery stops at level 18, below the surface's levels here: wait for every request to settle instead.
      await waitForStreaming(page);
      const frame = (await page.evaluate(
        (dark) => window.vibeglobePlayground?.checkFrame(dark),
        DARK_BELOW,
      )) as ScenarioReport;
      expect([frame.holes, frame.dark]).toEqual([0, 0]);
    });

    test(`imagery lands at the same place on terrain of either tiling scheme at 0°, 45° and 75° on ${backend} (F141)`, async ({
      page,
    }) => {
      // Twelve page loads (three latitudes, four combinations of tiling schemes), each streaming its terrain and
      // imagery: on a 320 × 240 canvas at zoom 8 each takes up to 30 s on the software GPU.
      test.setTimeout(480_000);
      await page.setViewportSize({ width: 320, height: 240 });
      const session = await fixtureSession(page);
      for (const lat of [0, 45, 75]) {
        const view = `backend=${backend}&session=${session}&${CLOCK}&imagery=world&lon=7&lat=${lat}&zoom=8&tilt=30`;
        const frames: PNG[] = [];
        // Web Mercator imagery on geographic, then on Web Mercator heightmap terrain; geographic imagery on Web
        // Mercator terrain, then on geographic terrain. The same analytic heights: the frames must agree.
        for (const query of [
          `${view}&terrain=terrarium&terrainTiling=geographic`,
          `${view}&terrain=terrarium`,
          `${view}&imageryTiling=geographic&terrain=terrarium`,
          `${view}&imageryTiling=geographic&terrain=terrarium&terrainTiling=geographic`,
        ]) {
          await openGlobe(page, query);
          // Geographic imagery shows other levels than the surface tiles': wait for every request to settle instead.
          await waitForTerrain(page);
          await waitForStreaming(page);
          frames.push(await canvasImage(page));
        }
        for (const [a, b] of [
          [0, 1],
          [2, 3],
        ] as const) {
          const frameA = frames[a];
          const frameB = frames[b];
          if (!frameA || !frameB) throw new Error('missing frame');
          const shift = measureShift(frameA, frameB);
          console.log(`latitude ${lat}, pair ${a}-${b}: ${JSON.stringify(shift)}`);
          expect(Math.abs(shift.dx)).toBeLessThan(1);
          expect(Math.abs(shift.dy)).toBeLessThan(1);
        }
      }
    });
  });
}

/** Pixels whose channels differ by more than `threshold` between two frames of the same size. */
function differingPixels(a: PNG, b: PNG, threshold: number): number {
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      if (Math.abs((a.data[i + c] ?? 0) - (b.data[i + c] ?? 0)) > threshold) {
        count++;
        break;
      }
    }
  }
  return count;
}

/** The imagery level of the tile under the screen center. */
async function centerImageryLevel(page: Page): Promise<number> {
  return page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    const canvas = document.querySelector<HTMLCanvasElement>('#globe');
    const center = globe?.screenToGeo({ xPx: (canvas?.clientWidth ?? 0) / 2, yPx: (canvas?.clientHeight ?? 0) / 2 });
    if (!globe || !center) return -1;
    const tile = globe
      .surfaceTiles()
      .find(
        (t) =>
          center.longitudeDeg >= t.westDeg &&
          center.longitudeDeg <= t.eastDeg &&
          center.latitudeDeg >= t.southDeg &&
          center.latitudeDeg <= t.northDeg,
      );
    return tile?.imageryLevel ?? -1;
  });
}

/**
 * Runs in the page: places `count` probe points on a grid over the view, each at the displayed terrain height
 * (`elevationAt`, the deepest resident level, which the settled frame draws). For each, a small quad that follows the
 * terrain `offset` above it must show at its center pixel, and one `offset` below it must stay hidden: the GPU's depth
 * test checks the rendered relief against the source heights within `offset`, which covers the depth precision.
 */
async function probeRelief(count: number): Promise<{ points: number; aboveHidden: number[]; belowShown: number[] }> {
  const globe = window.vibeglobePlayground?.globe;
  const canvas = document.querySelector<HTMLCanvasElement>('#globe');
  if (!globe || !canvas) throw new Error('no globe');
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const metersPerDeg = 111_320;
  const points: { longitudeDeg: number; latitudeDeg: number; offsetMeters: number; sizeMeters: number }[] = [];
  const side = Math.ceil(Math.sqrt(count));
  for (let row = 0; row < side && points.length < count; row++) {
    for (let col = 0; col < side && points.length < count; col++) {
      const at = globe.screenToGeo({ xPx: ((col + 0.5) / side) * width, yPx: ((row + 0.5) / side) * height });
      if (!at) continue;
      const ground = globe.elevationAt(at);
      // The probe covers about 8 px: its size and depth tolerance grow with the distance from the eye.
      const eye = globe.camera;
      const dLat = (at.latitudeDeg - eye.eyeLatitudeDeg) * metersPerDeg;
      const dLon = (at.longitudeDeg - eye.eyeLongitudeDeg) * metersPerDeg * Math.cos((at.latitudeDeg * Math.PI) / 180);
      const distance = Math.hypot(dLat, dLon, eye.altitudeMeters - ground.heightMeters);
      const pixelMeters = (distance * 2 * Math.tan(Math.PI / 8)) / height;
      points.push({
        ...at,
        sizeMeters: 4 * pixelMeters,
        offsetMeters: Math.max(1, 1e-3 * distance),
      });
    }
  }
  const quad = (p: (typeof points)[number], sign: number) => {
    const dDeg = p.sizeMeters / metersPerDeg;
    const dLonDeg = dDeg / Math.cos((p.latitudeDeg * Math.PI) / 180);
    const corner = (dx: number, dy: number) => {
      const position = { longitudeDeg: p.longitudeDeg + dx * dLonDeg, latitudeDeg: p.latitudeDeg + dy * dDeg };
      return { ...position, heightMeters: globe.elevationAt(position).heightMeters + sign * p.offsetMeters };
    };
    return [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)] as const;
  };
  const centers = async (sign: number, color: readonly [number, number, number]) => {
    globe.setDebugShapes(points.map((p) => ({ corners: quad(p, sign), colorRgb: color })));
    const frame = await globe.captureFrame();
    const scale = frame.widthPx / width;
    return points.map((p) => {
      const ground = globe.elevationAt(p).heightMeters + sign * p.offsetMeters;
      const screen = globe.geoToScreen({ ...p, heightMeters: ground });
      if (!screen) return false;
      const i = (Math.round(screen.yPx * scale) * frame.widthPx + Math.round(screen.xPx * scale)) * 4;
      const [r = 0, g = 0, b = 0] = [frame.rgba[i], frame.rgba[i + 1], frame.rgba[i + 2]];
      return color[0] === 1 ? r > 200 && g < 60 && b < 60 : b > 200 && r < 60 && g < 60;
    });
  };
  const above = await centers(1, [1, 0, 0]);
  const below = await centers(-1, [0, 0, 1]);
  globe.setDebugShapes([]);
  return {
    points: points.length,
    aboveHidden: above.flatMap((shown, i) => (shown ? [] : [i])),
    belowShown: below.flatMap((shown, i) => (shown ? [i] : [])),
  };
}
