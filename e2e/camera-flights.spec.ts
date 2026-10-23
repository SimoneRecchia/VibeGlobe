// Camera movements in the browser (M6): orbits about a picked or given point (F192) and a long flight that passes
// through every phase of the view on its own (F196). Both run on the manual engine clock, one frame at a time.
import { expect, test } from '@playwright/test';
import { geoToScreen, nextFrame, openGlobe, screenToGeo } from './support/globe.ts';
import { fixtureSession, waitForImagery } from './support/imagery.ts';

test.use({ viewport: { width: 320, height: 240 } });

const BACKENDS = ['webgpu', 'webgl2'] as const;
const CLOCK = 'clockStepMs=16.666666666666668';

for (const backend of BACKENDS) {
  test(`an orbit keeps a picked or a given point fixed on screen in every frame, and a cancel or user input stops it without a jump on ${backend} (F192)`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await openGlobe(page, `${CLOCK}&backend=${backend}&lon=12.5&lat=41.9&zoom=14&tilt=45`);
    const box = await page.locator('#globe').boundingBox();
    if (!box) throw new Error('no canvas');
    for (const stop of ['cancel', 'input'] as const) {
      // A picked point (under a screen position) for the cancel, the given target point for the user input.
      const picked = stop === 'cancel' ? await screenToGeo(page, { xPx: 200, yPx: 150 }) : undefined;
      const center = picked ?? { longitudeDeg: 12.5, latitudeDeg: 41.9 };
      const start = await geoToScreen(page, center);
      await page.evaluate(
        (c) => {
          const globe = window.vibeglobePlayground?.globe;
          if (!globe) throw new Error('no globe');
          (window as unknown as { orbiting: Promise<string> }).orbiting = globe.orbit({
            center: c,
            degreesPerSecond: 60,
          });
        },
        { longitudeDeg: center.longitudeDeg, latitudeDeg: center.latitudeDeg },
      );
      const headings: number[] = [];
      for (let frame = 0; frame < 30; frame++) {
        await nextFrame(page);
        const shown = await geoToScreen(page, center);
        expect(Math.hypot(shown.xPx - start.xPx, shown.yPx - start.yPx), `${stop}, frame ${frame}`).toBeLessThan(1);
        headings.push(await page.evaluate(() => window.vibeglobePlayground?.globe.camera.headingDeg ?? NaN));
      }
      // It turned: about a degree per frame at 60°/s on a 60 Hz clock.
      expect(Math.abs((headings.at(-1) ?? 0) - (headings[0] ?? 0))).toBeGreaterThan(10);
      if (stop === 'cancel')
        await page.evaluate(() => (window as unknown as { orbiting: { cancel(): void } }).orbiting.cancel());
      else {
        await page.mouse.move(box.x + 160, box.y + 120);
        await page.mouse.down();
        await page.mouse.move(box.x + 161, box.y + 120);
        await page.mouse.up();
      }
      const outcome = await page.evaluate(() => (window as unknown as { orbiting: Promise<string> }).orbiting);
      expect(outcome).toBe(stop === 'cancel' ? 'cancelled' : 'interrupted');
      // Stopped where it was: no further turning, no jump.
      const stoppedAt = await page.evaluate(() => window.vibeglobePlayground?.globe.camera.headingDeg ?? NaN);
      expect(Math.abs(stoppedAt - (headings.at(-1) ?? NaN))).toBeLessThan(3);
      for (let frame = 0; frame < 5; frame++) await nextFrame(page);
      expect(await page.evaluate(() => window.vibeglobePlayground?.globe.camera.headingDeg ?? NaN)).toBeCloseTo(
        stoppedAt,
        6,
      );
    }
  });

  test(`a flight from a tilted street view in Milan to one in Tokyo rises into the globe and descends, phase by phase, continuously and without empty pixels on ${backend} (F196)`, async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const session = await fixtureSession(page);
    await openGlobe(page, `${CLOCK}&backend=${backend}&imagery=world&session=${session}&lon=9.19&lat=45.46&zoom=17`);
    await waitForImagery(page);
    expect(await page.evaluate(() => window.vibeglobePlayground?.globe.camera.phase)).toBe('3d');
    await page.evaluate(() => {
      const globe = window.vibeglobePlayground?.globe;
      if (!globe) throw new Error('no globe');
      const samples: [string, number, number, number][] = [];
      (window as unknown as { flightSamples: typeof samples }).flightSamples = samples;
      globe.on('camera-change', (c) => samples.push([c.phase, c.morphFactor, c.tiltDeg, c.reliefFactor]));
      const flight = globe.flyTo({ longitudeDeg: 139.69, latitudeDeg: 35.68, zoom: 17 });
      (window as unknown as { flight: Promise<string> }).flight = flight;
      void flight.then(() => ((window as unknown as { flightDone: boolean }).flightDone = true));
    });
    let holes = 0;
    let done = false;
    for (let frame = 0; frame < 1200 && !done; frame++) {
      // Every twentieth frame is checked for holes inside the globe; the others are drawn plainly.
      if (frame % 20 === 0) holes += (await page.evaluate(() => window.vibeglobePlayground?.checkFrame()))?.holes ?? 1;
      else await nextFrame(page);
      done = await page.evaluate(() => (window as unknown as { flightDone: boolean }).flightDone);
    }
    expect(done).toBe(true);
    expect(await page.evaluate(() => (window as unknown as { flight: Promise<string> }).flight)).toBe('completed');
    const samples = await page.evaluate(
      () => (window as unknown as { flightSamples: [string, number, number, number][] }).flightSamples,
    );
    const phases = samples.map((s) => s[0]).filter((phase, i, all) => i === 0 || phase !== all[i - 1]);
    expect(phases).toEqual(['3d', '2d', 'flattening', 'globe', 'flattening', '2d', '3d']);
    for (let i = 1; i < samples.length; i++) {
      const [, morph, tilt, relief] = samples[i] ?? ['', NaN, NaN, NaN];
      const [, morph0, tilt0, relief0] = samples[i - 1] ?? ['', NaN, NaN, NaN];
      expect(Math.abs(morph - morph0), `frame ${i}`).toBeLessThan(0.2);
      expect(Math.abs(tilt - tilt0), `frame ${i}`).toBeLessThan(5);
      expect(Math.abs(relief - relief0), `frame ${i}`).toBeLessThan(0.2);
    }
    expect(holes).toBe(0);
  });
}
