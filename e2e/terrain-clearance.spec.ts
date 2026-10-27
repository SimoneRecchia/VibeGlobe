// The eye during a movement while finer terrain arrives (KB-219, not reproduced): a slow pan along a steep slope of the
// fixture tile server's analytic terrain (a 4,000 m peak at 6.86° E, 45.83° N), tilted uphill, with the fine terrain
// arriving late. Each frame writes the camera's target back, as movements and drags do; the eye may be below finer
// terrain only for the few frames of its smooth rise (F147), as the terrain under and ahead of it loads first.
import { expect, test } from '@playwright/test';
import { openGlobe, waitForIdle } from './support/globe.ts';
import { fixtureSession } from './support/imagery.ts';

test.use({ viewport: { width: 320, height: 240 } });

/** Frames of the pan: one `jumpTo` a frame, as a movement or a drag writes the target each frame. */
const FRAMES = 150;

test('panning along a steep slope while finer terrain arrives, the eye is inside it for a few frames at most (KB-219)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // Terrain from level 6 takes 400 ms: finer levels arrive while the camera moves.
  const session = await fixtureSession(page, [{ source: 'terrain', minLevel: 6, latencyMs: 400 }]);
  await openGlobe(page, `backend=webgl2&session=${session}&scenario=terrain-alps&imagery=&lon=6&lat=45&zoom=10`);
  await waitForIdle(page);
  // In every frame: the eye's altitude minus the finest terrain in memory under it.
  const rows = await page.evaluate(async (frames) => {
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) throw new Error('no globe');
    const out: number[] = [];
    const off = globe.on('frame', () => {
      const camera = globe.camera;
      const at = { longitudeDeg: camera.eyeLongitudeDeg, latitudeDeg: camera.eyeLatitudeDeg };
      out.push(camera.altitudeMeters - globe.elevationAt(at).heightMeters);
    });
    // East along the peak's north-east flank, at zoom 17, looking uphill to the south-west.
    for (let i = 0; i < frames; i++) {
      globe.jumpTo({ longitudeDeg: 6.87 + i * 0.00004, latitudeDeg: 45.84, zoom: 17, tiltDeg: 80, headingDeg: 225 });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    off();
    return out;
  }, FRAMES);
  // The longest run of frames with the eye below the finest terrain in memory.
  let run = 0;
  let longest = 0;
  for (const above of rows) {
    run = above < -0.05 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  console.log(
    `[KB-219] ${rows.length} frames, longest run below the terrain ${String(longest)}, lowest ${Math.min(...rows).toFixed(1)} m`,
  );
  expect(rows.length).toBeGreaterThan(FRAMES / 2);
  expect(longest).toBeLessThanOrEqual(12);
});
