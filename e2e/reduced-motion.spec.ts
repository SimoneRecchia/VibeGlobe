// Reduced motion (F214): flights fade to their target instead of traversing the path, following the system setting.
import { expect, test } from '@playwright/test';
import { openGlobe } from './support/globe.ts';

test.use({ viewport: { width: 320, height: 240 } });

test('with reduced motion a flight fades to its target in 300 ms, and the setting is followed at runtime (F214)', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openGlobe(page, 'backend=webgl2&lon=9.19&lat=45.46&zoom=12');
  expect(await page.evaluate(() => window.vibeglobePlayground?.globe.reducedMotion)).toBe(true);
  const flight = await page.evaluate(async () => {
    const globe = window.vibeglobePlayground?.globe;
    const canvas = document.querySelector<HTMLCanvasElement>('#globe');
    if (!globe || !canvas) throw new Error('no globe');
    const samples: { lon: number; opacity: string }[] = [];
    const off = globe.on('move', () => samples.push({ lon: globe.camera.longitudeDeg, opacity: canvas.style.opacity }));
    const start = performance.now();
    const outcome = await globe.flyTo({ longitudeDeg: 139.69, latitudeDeg: 35.68, zoom: 12 });
    off();
    return {
      outcome,
      ms: performance.now() - start,
      samples,
      end: globe.camera.longitudeDeg,
      opacity: canvas.style.opacity,
    };
  });
  expect(flight.outcome).toBe('completed');
  expect(flight.end).toBeCloseTo(139.69, 9);
  // No point of the path between the two places is shown, the view fades out and back in, and it ends opaque.
  for (const { lon } of flight.samples) expect(Math.abs(lon - 9.19) < 1e-9 || Math.abs(lon - 139.69) < 1e-9).toBe(true);
  expect(flight.samples.some(({ opacity }) => opacity !== '' && Number(opacity) < 0.5)).toBe(true);
  expect(flight.opacity).toBe('');
  // 300 ms of engine time, with a few frames of slack on a slow software renderer.
  expect(flight.ms).toBeLessThan(2000);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // The media query reports the change in its own task.
  await expect.poll(() => page.evaluate(() => window.vibeglobePlayground?.globe.reducedMotion)).toBe(false);
  const full = await page.evaluate(async () => {
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) throw new Error('no globe');
    const longitudes: number[] = [];
    const off = globe.on('move', () => longitudes.push(globe.camera.longitudeDeg));
    await globe.flyTo({ longitudeDeg: 9.19, latitudeDeg: 45.46, zoom: 12 }, { durationMs: 1500 });
    off();
    return longitudes;
  });
  expect(full.some((lon) => lon > 20 && lon < 130)).toBe(true);
});
