// The atmosphere drawn by the engine (M11, ADR 0040), through the playground's `?atmosphere=` and `?fog=0` switches:
// the sky above a tilted view's horizon (F391). The look of the sky, glow, haze and sun lighting is measured on the
// atmosphere harness (e2e/atmosphere.spec.ts).
import { expect, test } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, openGlobe } from './support/globe.ts';
import { waitForStreaming } from './support/imagery.ts';

test.use({ viewport: { width: 320, height: 240 } });

/** A view at the maximum tilt over the Alps, the horizon in the upper part of the frame. */
const TILTED = 'imagery=world&lon=8&lat=46&zoom=9&tilt=80';

for (const backend of ['webgpu', 'webgl2'] as const)
  test(`F391: the engine draws a sky above the horizon of a tilted view, not the background, on ${backend}`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const top = async (query: string): Promise<[number, number, number]> => {
      await openGlobe(page, `backend=${backend}&${TILTED}${query}`);
      await waitForStreaming(page);
      const image = await canvasImage(page);
      const sum = [0, 0, 0];
      // The top tenth of the frame: above the horizon at this tilt.
      const rows = Math.floor(image.height / 10);
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < image.width; x++)
          for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + (image.data[(y * image.width + x) * 4 + c] ?? 0);
      return sum.map((v) => v / (rows * image.width)) as [number, number, number];
    };
    const without = await top('');
    const sky = await top('&atmosphere=high');
    console.log(`[atmosphere] F391 ${backend}: top without ${without.map(Math.round)}, with ${sky.map(Math.round)}`);
    // Without the atmosphere the top is the clear color; with it, a sky: bright and bluer than red.
    const [r, g, b] = sky;
    expect(r + g + b).toBeGreaterThan(without.reduce((s, v) => s + v, 0) + 60);
    expect(b).toBeGreaterThan(r);
  });

const DEG = Math.PI / 180;

/** Mean luminance of a 5 × 5 px box around a point of the frame. */
function boxLuminance(image: PNG, xPx: number, yPx: number): number {
  let sum = 0;
  let count = 0;
  for (let y = Math.round(yPx) - 2; y <= Math.round(yPx) + 2; y++)
    for (let x = Math.round(xPx) - 2; x <= Math.round(xPx) + 2; x++) {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      const i = (y * image.width + x) * 4;
      sum += 0.2126 * (image.data[i] ?? 0) + 0.7152 * (image.data[i + 1] ?? 0) + 0.0722 * (image.data[i + 2] ?? 0);
      count++;
    }
  return count === 0 ? 0 : sum / count;
}

/**
 * The sub-solar point by the reference ephemeris of the NOAA solar calculator (from Meeus; about 0.01° this century),
 * written here independently of the engine's.
 */
function subsolarPoint(utcMs: number): { latitudeDeg: number; longitudeDeg: number } {
  const t = (utcMs / 86_400_000 + 2_440_587.5 - 2_451_545) / 36_525;
  const l0 = (280.46646 + t * (36_000.76983 + t * 0.0003032)) % 360;
  const m = (357.52911 + t * (35_999.05029 - 0.0001537 * t)) * DEG;
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const center =
    Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m) * 0.000289;
  const omega = (125.04 - 1934.136 * t) * DEG;
  const lambda = (l0 + center - 0.00569 - 0.00478 * Math.sin(omega)) * DEG;
  const epsilon =
    (23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60 + 0.00256 * Math.cos(omega)) * DEG;
  const declination = Math.asin(Math.sin(epsilon) * Math.sin(lambda));
  const y = Math.tan(epsilon / 2) ** 2;
  const l0Rad = l0 * DEG;
  // The equation of time, minutes.
  const equation =
    (4 / DEG) *
    (y * Math.sin(2 * l0Rad) -
      2 * e * Math.sin(m) +
      4 * e * y * Math.sin(m) * Math.cos(2 * l0Rad) -
      0.5 * y * y * Math.sin(4 * l0Rad) -
      1.25 * e * e * Math.sin(2 * m));
  const minutes = (utcMs % 86_400_000) / 60_000;
  return { latitudeDeg: declination / DEG, longitudeDeg: -(minutes + equation - 720) / 4 };
}

/**
 * The longitude east of the sub-solar point where the terminator crosses a latitude: where the Sun's elevation is zero,
 * sin φ sin δ + cos φ cos δ cos Δλ = 0.
 */
function terminatorLongitudeDeg(utcMs: number, latitudeDeg: number): number {
  const sun = subsolarPoint(utcMs);
  const cosDelta = -Math.tan(latitudeDeg * DEG) * Math.tan(sun.latitudeDeg * DEG);
  return sun.longitudeDeg + Math.acos(cosDelta) / DEG;
}

for (const backend of ['webgpu', 'webgl2'] as const)
  test(`F396: sun lighting puts the terminator where the Sun is, only when enabled, without a reload, on ${backend}`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const geo = (longitudeDeg: number, latitudeDeg: number) =>
      page.evaluate((p) => window.vibeglobePlayground?.globe.geoToScreen(p), { longitudeDeg, latitudeDeg });
    const show = async (
      timeMs: number,
      sunLighting: boolean,
      lonDeg = terminatorLongitudeDeg(timeMs, 0),
    ): Promise<PNG> => {
      await page.evaluate(
        ({ t, lon, lit }) => {
          const globe = window.vibeglobePlayground?.globe;
          globe?.setAtmosphere({ sunLighting: lit, timeMs: t });
          globe?.jumpTo({ longitudeDeg: lon, latitudeDeg: 20 });
        },
        { t: timeMs, lon: lonDeg, lit: sunLighting },
      );
      await waitForStreaming(page);
      return canvasImage(page);
    };
    await openGlobe(page, `backend=${backend}&imagery=world&atmosphere=high&fog=0&zoom=1.6`);
    expect(await page.evaluate(() => window.vibeglobePlayground?.globe.atmosphere.sunLighting)).toBe(false);
    await page.evaluate(() => Object.assign(window, { sameDocument: true }));
    // The equinox and both solstices: the terminator crosses the equator and 40° N where the Sun's position puts it.
    for (const iso of ['2026-03-20T14:46:00Z', '2026-06-21T08:24:00Z', '2026-12-21T20:03:00Z']) {
      const timeMs = Date.parse(iso);
      const unlit = await show(timeMs, false);
      const lit = await show(timeMs, true);
      // The shading in linear light: the lit frame over the unlit one, pixel by pixel (the imagery's own colors cancel
      // out), the sRGB output undone with a 2.2 gamma.
      const shade = (x: number, y: number): number =>
        (boxLuminance(lit, x, y) / Math.max(1, boxLuminance(unlit, x, y))) ** 2.2;
      for (const latitudeDeg of [0, 40]) {
        const terminatorDeg = terminatorLongitudeDeg(timeMs, latitudeDeg);
        // Degrees of the Sun's elevation per degree of longitude at the terminator: offsets are in elevation.
        const sun = subsolarPoint(timeMs);
        const rate =
          Math.cos(latitudeDeg * DEG) *
          Math.cos(sun.latitudeDeg * DEG) *
          Math.sin((terminatorDeg - sun.longitudeDeg) * DEG);
        const at = async (elevationDeg: number): Promise<number> => {
          const point = await geo(terminatorDeg - elevationDeg / rate, latitudeDeg);
          if (!point) throw new Error('the terminator is not in view');
          return shade(point.xPx, point.yPx);
        };
        // The night side's level well past the terminator; where the Sun stands 5° up the ground is lit, 2° below the
        // horizon the light is gone.
        const night = await at(-15);
        const [before, after, day] = [await at(5), await at(-2), await at(30)];
        console.log(
          `[sun] F396 ${backend} ${iso} ${latitudeDeg}° N: shade at the Sun's elevation 30° ${day.toFixed(3)}, 5° ${before.toFixed(3)}, −2° ${after.toFixed(3)}, night ${night.toFixed(3)}`,
        );
        expect(day - night, 'the day side is lit').toBeGreaterThan(0.1);
        expect(before - night, 'lit with the Sun 5° up').toBeGreaterThan(0.006);
        expect(Math.abs(after - night), 'dark with the Sun 2° down').toBeLessThan(0.003);
      }
    }
    // Without sun lighting nothing is shaded, whatever the time.
    const a = await show(Date.parse('2026-03-20T14:46:00Z'), false, 0);
    const b = await show(Date.parse('2026-03-20T02:46:00Z'), false, 0);
    let different = 0;
    for (let i = 0; i < a.data.length; i += 4) if (Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)) > 8) different++;
    expect(different).toBeLessThan(a.data.length / 400);
    // The time changed the view in the same document: nothing reloaded.
    expect(await page.evaluate(() => 'sameDocument' in window)).toBe(true);
  });

for (const backend of ['webgpu', 'webgl2'] as const)
  test(`F396: sun lighting shades the terrain's slopes by the Sun's direction on ${backend}`, async ({ page }) => {
    test.setTimeout(120_000);
    // Full relief at this zoom (it rises from ground zoom 10 by default, F154).
    const FULL_RELIEF = encodeURIComponent(JSON.stringify({ relief: { startGroundZoom: -2, endGroundZoom: -1 } }));
    // Straight down on the fixture terrain's 4,000 m peak (6.86° E, 45.83° N), whose flanks are steepest (6.5°) 0.27° from it.
    await openGlobe(
      page,
      `backend=${backend}&imagery=world&terrain=terrarium&session=sun-terrain&atmosphere=high&fog=0&lon=6.86&lat=45.83&zoom=8&curves=${FULL_RELIEF}`,
    );
    const flank = async (timeMs: number | undefined): Promise<{ east: number; west: number }> => {
      await page.evaluate(
        (t) =>
          window.vibeglobePlayground?.globe.setAtmosphere(
            t === undefined ? { sunLighting: false } : { sunLighting: true, timeMs: t },
          ),
        timeMs,
      );
      await waitForStreaming(page);
      const image = await canvasImage(page);
      const at = async (longitudeDeg: number): Promise<number> => {
        const point = await page.evaluate((p) => window.vibeglobePlayground?.globe.geoToScreen(p), {
          longitudeDeg,
          latitudeDeg: 45.83,
        });
        if (!point) throw new Error('the flank is not in view');
        return boxLuminance(image, point.xPx, point.yPx);
      };
      return { east: await at(6.86 + 0.27), west: await at(6.86 - 0.27) };
    };
    const unlit = await flank(undefined);
    // The midsummer Sun rises in the east-northeast and sets in the west-northwest, 20° and 15° up.
    const morning = await flank(Date.parse('2026-06-21T05:30:00Z'));
    const evening = await flank(Date.parse('2026-06-21T18:00:00Z'));
    const ratio = (lit: { east: number; west: number }) => lit.east / unlit.east / (lit.west / unlit.west);
    console.log(
      `[sun] F396 ${backend} terrain: east over west flank ${ratio(morning).toFixed(2)} in the morning, ${ratio(evening).toFixed(2)} in the evening`,
    );
    expect(ratio(morning)).toBeGreaterThan(1.15);
    expect(ratio(evening)).toBeLessThan(1 / 1.15);
  });
