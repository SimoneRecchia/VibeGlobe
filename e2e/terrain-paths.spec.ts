// Terrain-safe camera paths (F212): flights, eases and orbits keep the eye above the relief, without a jump.
import { expect, test, type Page } from '@playwright/test';
import { openGlobe, waitForIdle } from './support/globe.ts';

test.use({ viewport: { width: 320, height: 240 } });

/**
 * The manual clock's step: 30 Hz, so the software GPU of CI draws half the frames of a 60 Hz path (about a second each
 * at the start, two hundred terrain tiles at a 75° tilt).
 */
const FRAME_MS = 1000 / 30;

/** The playground's default eye clearance above the displayed terrain (F146), meters. */
const CLEARANCE_METERS = 10;

interface Sample {
  readonly clearanceMeters: number;
  readonly altitudeMeters: number;
}

/** Runs `movement` in the page and records the eye's height above the drawn ground in every frame until it settles. */
async function recordMovement(page: Page, movement: string): Promise<{ samples: Sample[]; outcome: string }> {
  return page.evaluate(async (code) => {
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) throw new Error('no globe');
    const samples: Sample[] = [];
    const off = globe.on('frame', () => {
      const camera = globe.camera;
      samples.push({
        clearanceMeters: camera.altitudeMeters - camera.groundHeightMeters,
        altitudeMeters: camera.altitudeMeters,
      });
    });
    const outcome = (await new Function('globe', `return ${code}`)(globe)) as string;
    off();
    return { samples, outcome };
  }, movement);
}

function expectAboveAndContinuous(samples: readonly Sample[]): void {
  expect(samples.length).toBeGreaterThan(10);
  for (const [i, sample] of samples.entries()) {
    expect(sample.clearanceMeters, `frame ${i}`).toBeGreaterThanOrEqual(CLEARANCE_METERS - 0.5);
    // No jump: the eye's height changes by a small share of itself per 60 Hz frame, so twice that per 30 Hz frame.
    const previous = samples[i - 1];
    if (previous)
      expect(Math.abs(sample.altitudeMeters - previous.altitudeMeters), `frame ${i}`).toBeLessThan(
        (0.1 * previous.altitudeMeters + 50) * (FRAME_MS / (1000 / 60)),
      );
  }
}

test('flights, eases and orbits across the fixture peak keep the eye above the relief, with no jump (F212)', async ({
  page,
}) => {
  // The ease takes about 90 s on the software GPU, the flight about 110 s and the orbit about 30 s (frames of 140,000
  // terrain triangles at a 75° tilt), at half the frames of a 60 Hz clock.
  test.setTimeout(360_000);
  // West of the fixture's 4,000 m peak at 6.86° E, low: the straight way east passes through the mountain.
  await openGlobe(
    page,
    `backend=webgl2&scenario=terrain-alps&clockStepMs=${FRAME_MS}&lon=6.55&lat=45.83&zoom=14&tilt=75&heading=90`,
  );
  await waitForIdle(page);
  const target = { longitudeDeg: 7.17, latitudeDeg: 45.83, zoom: 14 };
  const ease = await recordMovement(page, `globe.easeTo(${JSON.stringify(target)}, { durationMs: 4000 })`);
  console.log(`[F212] ease: ${ease.samples.length} frames`);
  expect(ease.outcome).toBe('completed');
  expectAboveAndContinuous(ease.samples);
  // The peak lies under the path: the eye was lifted over it, far above where it started (about 1,900 m). The drawn
  // summit is the loaded level's, below the fixture's analytic 4,000 m, so the clearance above the drawn ground (checked
  // in every frame) is what the eye keeps.
  const start = ease.samples[0]?.altitudeMeters ?? NaN;
  expect(Math.max(...ease.samples.map((s) => s.altitudeMeters))).toBeGreaterThan(start + 1500);
  const arrived = await page.evaluate(() => window.vibeglobePlayground?.globe.camera);
  expect(arrived?.longitudeDeg).toBeCloseTo(target.longitudeDeg, 9);
  expect(arrived?.latitudeDeg).toBeCloseTo(target.latitudeDeg, 9);
  const fly = await recordMovement(page, `globe.flyTo({ longitudeDeg: 6.55, latitudeDeg: 45.83, zoom: 14 })`);
  console.log(`[F212] fly: ${fly.samples.length} frames`);
  expect(fly.outcome).toBe('completed');
  expectAboveAndContinuous(fly.samples);
  // A low orbit around the summit, cancelled after a quarter turn.
  await page.evaluate(() =>
    window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 6.86, latitudeDeg: 45.83, zoom: 13 }),
  );
  await waitForIdle(page);
  // Cancelled after two seconds of the manual clock (a quarter turn), counted in frames: real time would see only a few
  // frames of the software GPU.
  const orbit = await recordMovement(
    page,
    `(() => { const o = globe.orbit({ degreesPerSecond: 45 }); let n = 0; const off = globe.on('frame', () => {
      if (++n >= ${Math.round(2000 / FRAME_MS)}) { off(); o.cancel(); } }); return o; })()`,
  );
  console.log(`[F212] orbit: ${orbit.samples.length} frames`);
  expect(orbit.outcome).toBe('cancelled');
  expectAboveAndContinuous(orbit.samples);
});
