import { expect, test } from '@playwright/test';
import { openGlobe, type ScenarioReport } from './support/globe.js';
import { fixtureSession } from './support/imagery.js';

/**
 * The scenario suite (F562, F563, F125): scripted camera paths over the fixture tile server, every frame checked in
 * the page for background or black pixels inside the Earth and, in still windows, for pops. The first path,
 * `zoom-orbit-to-street` (globe to street with a rotation and a tilt change), runs in `imagery-quality.spec.ts`
 * (F105); this file runs the second, `long-path` (Milan to Tokyo, then a burst of fast pans).
 */

test.describe.configure({ timeout: 300_000 });
test.use({ viewport: { width: 800, height: 600 } });

/** Fixture `levels` pixels have every channel at 40 or more; the page background is (11, 16, 32). */
const BLACK_BELOW = 35;

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(`a long path with a burst of fast pans shows no background or black pixel and no pop on ${backend} (F562, F563)`, async ({
    page,
  }) => {
    const session = await fixtureSession(page, [{ minLevel: 3, latencyMs: 400 }]);
    await openGlobe(page, `backend=${backend}&imagery=levels&session=${session}&clockStepMs=16.666666666666668`);
    const report = (await page.evaluate(
      (dark) => window.vibeglobePlayground?.recordScenario('long-path', dark),
      BLACK_BELOW,
    )) as ScenarioReport;
    console.log(`long-path ${backend}: ${JSON.stringify(report)}`);
    expect(report.frames).toBeGreaterThan(60);
    expect(report.staticFrames).toBeGreaterThan(10);
    expect([report.holes, report.dark, report.pops]).toEqual([0, 0, 0]);
  });
}
