// Fitting the view to objects (M10, F387): a point, a line, a polygon and a point 3,000 m up, framed with padding in
// the flat and tilted views; every vertex, at its height, inside the padded viewport, one of them at its edge.
import { expect, test } from '@playwright/test';
import { openGlobe, waitForIdle } from './support/globe.ts';

declare global {
  interface Window {
    /** `?scenario=data-fit` (`apps/playground/src/layers-fit.ts`). */
    vibeglobeFit?: { objects: { geometry: unknown }[]; fit(paddingPx: number): Promise<string> };
  }
}

test.use({ viewport: { width: 480, height: 360 } });

const BACKENDS = ['webgpu', 'webgl2'] as const;
const PADDING = 40;

for (const backend of BACKENDS) {
  test(`fitting to features and raised positions frames all of them, heights included, with the padding and no wider on ${backend} (F387)`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    // The movement is a flight; reduced motion makes it a short fade (F214), so the check follows arrival.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openGlobe(page, `backend=${backend}&scenario=data-fit&lon=0&lat=0&zoom=3`);
    await page.waitForFunction(() => window.vibeglobeFit !== undefined);
    for (const view of [
      { name: 'flat', mode: '2d', tiltDeg: 0 },
      { name: 'tilted', mode: '3d', tiltDeg: 50 },
    ] as const) {
      await page.evaluate(({ mode, tiltDeg }) => {
        const globe = window.vibeglobePlayground?.globe;
        globe?.setViewMode(mode);
        globe?.jumpTo({ longitudeDeg: 0, latitudeDeg: 0, zoom: 3, tiltDeg });
      }, view);
      await page.waitForTimeout(300);
      expect(await page.evaluate((padding) => window.vibeglobeFit?.fit(padding), PADDING)).toBe('completed');
      await waitForIdle(page);
      const report = await page.evaluate(() => {
        const globe = window.vibeglobePlayground?.globe;
        const fit = window.vibeglobeFit;
        if (!globe || !fit) throw new Error('no scenario');
        const points: { xPx: number; yPx: number }[] = [];
        const visit = (value: unknown): void => {
          if (!Array.isArray(value)) return;
          if (typeof value[0] === 'number') {
            const [lon = 0, lat = 0, height = 0] = value as number[];
            const p = globe.geoToScreen({ longitudeDeg: lon, latitudeDeg: lat, heightMeters: height });
            points.push(p ?? { xPx: NaN, yPx: NaN });
          } else for (const item of value) visit(item);
        };
        for (const feature of fit.objects) visit((feature.geometry as { coordinates: unknown }).coordinates);
        return { points, tilt: globe.camera.tiltDeg };
      });
      const { points } = report;
      expect(points.length).toBe(9);
      for (const p of points) {
        expect(p.xPx, view.name).toBeGreaterThanOrEqual(PADDING - 0.5);
        expect(p.xPx, view.name).toBeLessThanOrEqual(480 - PADDING + 0.5);
        expect(p.yPx, view.name).toBeGreaterThanOrEqual(PADDING - 0.5);
        expect(p.yPx, view.name).toBeLessThanOrEqual(360 - PADDING + 0.5);
      }
      // No wider than needed: some vertex lies within 2 px of the padded edge.
      const gap = Math.min(
        ...points.flatMap((p) => [p.xPx - PADDING, 480 - PADDING - p.xPx, p.yPx - PADDING, 360 - PADDING - p.yPx]),
      );
      expect(gap, view.name).toBeLessThanOrEqual(2);
      if (view.name === 'tilted') expect(report.tilt).toBeGreaterThan(20);
    }
  });
}
