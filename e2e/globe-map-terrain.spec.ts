import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { BACKGROUND_RGB, canvasImage, nextFrame, openGlobe, waitForIdle } from './support/globe.ts';

/**
 * M5 with relief and the wrapping flat map (ADR 0008, ADR 0034) on both backends: the vertical scale of the plane at
 * every latitude (F157), the antimeridian on the flat map (F159) and the terrain tilt clamp (F165). A 320 × 240 canvas
 * (CLAUDE.md, Working efficiently).
 */
const BACKENDS = ['webgpu', 'webgl2'] as const;
const CLOCK = 'clockStepMs=16.666666666666668';
const DEG = Math.PI / 180;

test.use({ viewport: { width: 320, height: 240 } });

interface CameraSample {
  longitudeDeg: number;
  latitudeDeg: number;
  tiltDeg: number;
  chosenTiltDeg: number;
  altitudeMeters: number;
  groundHeightMeters: number;
  rangeMeters: number;
  phase: string;
}

async function cameraOf(page: Page): Promise<CameraSample> {
  return page.evaluate(() => {
    const camera = window.vibeglobePlayground?.globe.camera;
    if (!camera) throw new Error('no globe');
    return {
      longitudeDeg: camera.longitudeDeg,
      latitudeDeg: camera.latitudeDeg,
      tiltDeg: camera.tiltDeg,
      chosenTiltDeg: camera.chosenTiltDeg,
      altitudeMeters: camera.altitudeMeters,
      groundHeightMeters: camera.groundHeightMeters,
      rangeMeters: camera.rangeMeters,
      phase: camera.phase,
    };
  });
}

function isBackground(image: PNG, x: number, y: number): boolean {
  const i = (y * image.width + x) * 4;
  return (
    image.data[i] === BACKGROUND_RGB[0] &&
    image.data[i + 1] === BACKGROUND_RGB[1] &&
    image.data[i + 2] === BACKGROUND_RGB[2]
  );
}

/**
 * The fixture cone's height-to-base ratio on screen: the slope of its east flank, rows per column, fitted over every
 * row from below the tip to just above the horizon (the first row drawn all across) so rounding averages out; and how
 * far each flank's silhouette strays from its fitted line at most, pixels (KB-097: a ledge on the west flank).
 */
function coneRatio(image: PNG): { topRow: number; horizonRow: number; ratio: number; ledgePx: number } {
  const eastEdge = (y: number): number => {
    for (let x = image.width - 1; x >= 0; x--) if (!isBackground(image, x, y)) return x;
    return -1;
  };
  const westEdge = (y: number): number => {
    for (let x = 0; x < image.width; x++) if (!isBackground(image, x, y)) return x;
    return -1;
  };
  let topRow = 0;
  while (topRow < image.height && eastEdge(topRow) < 0) topRow++;
  let horizonRow = topRow;
  while (horizonRow < image.height && eastEdge(horizonRow) >= 0 && isBackground(image, 0, horizonRow)) horizonRow++;
  const rows: number[] = [];
  for (let y = topRow + 3; y < horizonRow - 2; y++) rows.push(y);
  const xs = rows.map(eastEdge);
  const meanY = rows.reduce((a, b) => a + b, 0) / rows.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  let covariance = 0;
  let variance = 0;
  for (let i = 0; i < rows.length; i++) {
    covariance += ((rows[i] ?? 0) - meanY) * ((xs[i] ?? 0) - meanX);
    variance += ((xs[i] ?? 0) - meanX) ** 2;
  }
  return {
    topRow,
    horizonRow,
    ratio: covariance / variance,
    ledgePx: Math.max(straying(rows, xs), straying(rows, rows.map(westEdge))),
  };
}

/** The largest distance in columns between a flank's silhouette and the line fitted through it (column on row). */
function straying(rows: readonly number[], xs: readonly number[]): number {
  const meanY = rows.reduce((a, b) => a + b, 0) / rows.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  let covariance = 0;
  let variance = 0;
  for (let i = 0; i < rows.length; i++) {
    covariance += ((rows[i] ?? 0) - meanY) * ((xs[i] ?? 0) - meanX);
    variance += ((rows[i] ?? 0) - meanY) ** 2;
  }
  const slope = covariance / variance;
  return Math.max(...rows.map((y, i) => Math.abs((xs[i] ?? 0) - (meanX + slope * (y - meanY)))));
}

for (const backend of BACKENDS) {
  test.describe(backend, () => {
    test(`the same cone keeps its screen-space height-to-base ratio at 0°, 45° and 70° on the flat map on ${backend} (F157)`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      // The fixture cones (scripts/fixtures/tiles/terrain.ts): 500 m high, 1 km in radius, at 100° E. The camera looks
      // north at one from 2.5 km south of it, 1.5 km away and tilted 83°, so its eye is below the peak and the tip shows
      // against the sky. The base image only: the silhouette needs no imagery.
      const ratios: number[] = [];
      for (const latitudeDeg of [0, 45, 70]) {
        // The same ground zoom (so the same range) at each latitude: Web Mercator zoom = ground zoom + log2(cos φ).
        const zoom = 14.2 + Math.log2(Math.cos(latitudeDeg * DEG));
        await openGlobe(
          page,
          `backend=${backend}&scenario=terrain-cones&imagery=&lat=${latitudeDeg - 2500 / 111_132}&zoom=${zoom}&tilt=83&heading=0`,
        );
        await waitForIdle(page);
        const camera = await cameraOf(page);
        expect(camera.phase).toBe('3d');
        expect(camera.tiltDeg).toBeCloseTo(83, 6);
        expect(camera.rangeMeters / 1500).toBeCloseTo(1, 1);
        const image = await canvasImage(page);
        const { topRow, horizonRow, ratio, ledgePx } = coneRatio(image);
        expect(topRow, `the tip shows at ${latitudeDeg}°`).toBeGreaterThan(10);
        // Both flanks straight: no ledge where the mesh skipped the grid's vertices (KB-097).
        expect(ledgePx, `the flanks are straight at ${latitudeDeg}°`).toBeLessThan(3);
        expect(horizonRow - topRow, `the tip stands above the horizon at ${latitudeDeg}°`).toBeGreaterThan(15);
        ratios.push(ratio);
      }
      // Identical within 5% (pixel rounding): unscaled relief would make the 70° cone 2.9 times flatter.
      expect(Math.max(...ratios) / Math.min(...ratios), ratios.join(', ')).toBeLessThan(1.05);
    });

    test(`dragging the flat map east across the antimeridian is continuous, with no gap or seam, on ${backend} (F159)`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await openGlobe(page, `backend=${backend}&scenario=map-2d-antimeridian`);
      await waitForIdle(page);
      const box = await page.locator('#globe').boundingBox();
      if (!box) throw new Error('no canvas');
      let previous = await cameraOf(page);
      expect(previous.phase).toBe('2d');
      let crossings = 0;
      for (let drag = 0; drag < 6; drag++) {
        // Each drag starts 0.8° west of the antimeridian and crosses it.
        await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 179.2 }));
        await nextFrame(page);
        previous = await cameraOf(page);
        // Dragging the map west moves the view east: 240 px in 8 moves.
        await page.mouse.move(box.x + 280, box.y + 120);
        await page.mouse.down();
        for (let step = 1; step <= 8; step++) {
          await page.mouse.move(box.x + 280 - 30 * step, box.y + 120);
          await nextFrame(page);
          const camera = await cameraOf(page);
          expect(camera.longitudeDeg).toBeGreaterThanOrEqual(-180);
          expect(camera.longitudeDeg).toBeLessThan(180);
          // Continuous: each move steps east by about the same small amount, wrapped.
          const stepDeg = ((camera.longitudeDeg - previous.longitudeDeg + 540) % 360) - 180;
          expect(stepDeg, `drag ${drag} step ${step}`).toBeGreaterThan(0);
          expect(stepDeg).toBeLessThan(1);
          if (camera.longitudeDeg < previous.longitudeDeg) crossings++;
          previous = camera;
        }
        await page.mouse.up();
        await waitForIdle(page);
        const image = await canvasImage(page);
        let empty = 0;
        for (let y = 0; y < image.height; y++)
          for (let x = 0; x < image.width; x++) if (isBackground(image, x, y)) empty++;
        expect(empty, `empty pixels after drag ${drag}`).toBe(0);
        expectNoSeam(
          image,
          await page.evaluate(() =>
            window.vibeglobePlayground?.globe.geoToScreen({ longitudeDeg: 180, latitudeDeg: 0 }),
          ),
        );
      }
      expect(crossings).toBe(6);
    });

    test(`a chosen 70° tilt is lowered only while the eye would enter a mountain wall and comes back smoothly on ${backend} (F165)`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      // The fixture ridge: 1,500 m high along 46.5° N from 7° to 10° E. The camera looks north from 4.4 km south of it.
      await openGlobe(page, `backend=${backend}&${CLOCK}&scenario=tilt-clamp-terrain`);
      await waitForIdle(page);
      const start = await cameraOf(page);
      expect(start.tiltDeg).toBeCloseTo(70, 6);
      // North over the ridge until the eye has passed it, then back south: 100 m of target motion per frame.
      const path: number[] = [];
      for (let i = 0; i <= 100; i++) path.push(start.latitudeDeg + (i * 100) / 111_132);
      for (let i = 99; i >= 0; i--) path.push(start.latitudeDeg + (i * 100) / 111_132);
      // One page task moves the camera and records each drawn frame: round trips would dominate the run.
      const samples = await page.evaluate(async (latitudes) => {
        const globe = window.vibeglobePlayground?.globe;
        if (!globe) throw new Error('no globe');
        const out = [];
        for (const latitudeDeg of latitudes) {
          globe.jumpTo({ latitudeDeg });
          await new Promise<void>((resolve) => {
            const off = globe.on('frame', () => {
              off();
              resolve();
            });
          });
          const camera = globe.camera;
          out.push({
            longitudeDeg: camera.longitudeDeg,
            latitudeDeg: camera.latitudeDeg,
            tiltDeg: camera.tiltDeg,
            chosenTiltDeg: camera.chosenTiltDeg,
            altitudeMeters: camera.altitudeMeters,
            groundHeightMeters: camera.groundHeightMeters,
            rangeMeters: camera.rangeMeters,
            phase: camera.phase,
          });
        }
        return out;
      }, path);
      let clampedFrames = 0;
      for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        if (!sample) continue;
        // Never inside the terrain, and the choice never changes.
        expect(sample.altitudeMeters - sample.groundHeightMeters, `frame ${i}`).toBeGreaterThan(0);
        expect(sample.chosenTiltDeg).toBeCloseTo(70, 9);
        const before = samples[i - 1];
        if (!before) continue;
        // No jump: a 100 m move changes the tilt by a few degrees at most.
        expect(Math.abs(sample.tiltDeg - before.tiltDeg), `frame ${i}`).toBeLessThan(5);
        // Lowered only while required: a frame that lowers the tilt has the eye at the clearance above the ground.
        if (sample.tiltDeg < before.tiltDeg - 1e-6) {
          clampedFrames++;
          expect(sample.altitudeMeters - sample.groundHeightMeters, `frame ${i}`).toBeLessThan(50);
        }
      }
      expect(clampedFrames).toBeGreaterThanOrEqual(3);
      // Back south, clear of the ridge: the chosen 70° again.
      expect(samples.at(-1)?.tiltDeg).toBeCloseTo(70, 6);
      expect(Math.min(...samples.map((sample) => sample.tiltDeg))).toBeLessThan(69);
    });
  });
}

/**
 * Asserts no seam where the map wraps: the color steps between neighboring columns across the antimeridian are no
 * larger than elsewhere in the same rows (the fixture's `smooth` imagery is continuous across 180°).
 */
function expectNoSeam(image: PNG, wrap: { xPx: number; yPx: number } | undefined): void {
  if (!wrap || wrap.xPx < 2 || wrap.xPx > image.width - 3) return;
  const step = (x: number, y: number): number => {
    const a = (y * image.width + x) * 4;
    const b = a + 4;
    return (
      Math.abs((image.data[a] ?? 0) - (image.data[b] ?? 0)) +
      Math.abs((image.data[a + 1] ?? 0) - (image.data[b + 1] ?? 0)) +
      Math.abs((image.data[a + 2] ?? 0) - (image.data[b + 2] ?? 0))
    );
  };
  const column = Math.round(wrap.xPx);
  let atWrap = 0;
  let elsewhere = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = column - 2; x <= column + 1; x++) atWrap = Math.max(atWrap, step(x, y));
    for (let x = 0; x < image.width - 1; x++) if (Math.abs(x - column) > 4) elsewhere = Math.max(elsewhere, step(x, y));
  }
  expect(atWrap, 'the largest color step at the antimeridian').toBeLessThanOrEqual(elsewhere + 3);
}
