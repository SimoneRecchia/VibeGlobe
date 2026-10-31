// Fog-aware detail (F657, which replaced F574 by the decision on open question 37, ADR 0183; F574 had replaced F395,
// ADR 0046): the same tilted flight with the fog drawn, once loading coarser tiles where the fog hides the ground and
// once at full detail (`QualitySettings.fogAwareDetail`). Every tile request of both runs is recorded with the eye of
// its frame: none of the fog-aware run is a tile whose parent lies entirely inside full fog (the selection never refines
// such a tile), and it requests fewer tiles whose center lies in full fog. The fogged band near the horizon looks the
// same, and neither run has a black or empty pixel. The total count is logged only: it follows how many tiles arrive
// while a slow runner draws each frame, not the fog (KB-230).
import { expect, test, type Page } from '@playwright/test';
import { surfaceVisibility } from '@vibeglobe/core';
import { canvasImage, openGlobe, waitForIdle } from './support/globe.ts';

test.use({ viewport: { width: 320, height: 240 } });

/** A hazy day: ten times a clear day's aerosols (the most allowed), so the full-fog distance falls well inside the view. */
const HAZE = 10;
/** `FULL_FOG_VISIBILITY` of `packages/core/src/surface/surface-quadtree.hot.ts`: under one 8-bit step of color. */
const FULL_FOG = 1 / 255;
const A = 6378137;
const E2 = 6.69437999014e-3;
const POLAR_SCALE = 6378.137 / 6356.752314245;
const DEG = Math.PI / 180;

interface Eye {
  lon: number;
  lat: number;
  altitudeMeters: number;
}

interface Run {
  requested: number;
  /** Each request's tile and the eye of the frame that started it. */
  requests: { level: number; x: number; y: number; priority: number; eye: Eye }[];
  gpuBytes: number;
  holes: number;
  dark: number;
  /** The last frame's pixels, RGB. */
  pixels: number[];
}

function ecef(lonRad: number, latRad: number, heightMeters: number): [number, number, number] {
  const n = A / Math.sqrt(1 - E2 * Math.sin(latRad) ** 2);
  return [
    (n + heightMeters) * Math.cos(latRad) * Math.cos(lonRad),
    (n + heightMeters) * Math.cos(latRad) * Math.sin(lonRad),
    (n * (1 - E2) + heightMeters) * Math.sin(latRad),
  ];
}

/** The fraction of light from a ground point that reaches the eye, as the engine's selection computes it. */
function visibility(eye: [number, number, number], point: [number, number, number]): number {
  const [ex, ey, ez] = [eye[0], eye[1], eye[2] * POLAR_SCALE];
  const [dx, dy, dz] = [point[0] - eye[0], point[1] - eye[1], (point[2] - eye[2]) * POLAR_SCALE];
  const eyeDistance = Math.hypot(ex, ey, ez);
  const length = Math.hypot(dx, dy, dz);
  if (length === 0) return 1;
  return surfaceVisibility(
    {
      eyeAltitudeKm: eyeDistance / 1000 - 6378.137,
      radiusKm: 6378.137,
      viewMu: (dx * ex + dy * ey + dz * ez) / (length * eyeDistance),
      maxDistanceKm: Math.hypot(point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]) / 1000,
    },
    HAZE,
  );
}

/** Whether the ground at a tile's center lies in full fog seen from `eye`: the fog hides most of the tile. */
function centerFogged(level: number, x: number, y: number, eye: Eye): boolean {
  const b = bounds(level, x, y);
  const center = ecef((b.west + b.east) / 2, (b.south + b.north) / 2, 0);
  return visibility(ecef(eye.lon * DEG, eye.lat * DEG, eye.altitudeMeters), center) < FULL_FOG;
}

/** The bounds of a Web Mercator tile, radians. */
function bounds(level: number, x: number, y: number) {
  const n = 2 ** level;
  const lat = (row: number) => Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n)));
  return {
    west: (x / n) * 2 * Math.PI - Math.PI,
    east: ((x + 1) / n) * 2 * Math.PI - Math.PI,
    north: lat(y),
    south: lat(y + 1),
  };
}

/**
 * Whether a tile lies entirely inside full fog seen from `eye`, judged only for tiles smaller than their distance from
 * the eye (the selection measures from a bounding volume, which a continent-sized tile spans near and far): the most
 * light from a 5 × 5 grid and from its point nearest the eye stays under a quarter of full fog's threshold.
 */
function entirelyFogged(level: number, x: number, y: number, eye: Eye): boolean {
  const b = bounds(level, x, y);
  const eyeEcef = ecef(eye.lon * DEG, eye.lat * DEG, eye.altitudeMeters);
  const clamp = (v: number, low: number, high: number) => Math.min(high, Math.max(low, v));
  const nearest = ecef(clamp(eye.lon * DEG, b.west, b.east), clamp(eye.lat * DEG, b.south, b.north), 0);
  const sw = ecef(b.west, b.south, 0);
  const ne = ecef(b.east, b.north, 0);
  const distance = Math.hypot(nearest[0] - eyeEcef[0], nearest[1] - eyeEcef[1], nearest[2] - eyeEcef[2]);
  if (distance <= Math.hypot(sw[0] - ne[0], sw[1] - ne[1], sw[2] - ne[2])) return false;
  let most = visibility(eyeEcef, nearest);
  for (let i = 0; i <= 4; i++)
    for (let j = 0; j <= 4; j++)
      most = Math.max(
        most,
        visibility(eyeEcef, ecef(b.west + ((b.east - b.west) * i) / 4, b.south + ((b.north - b.south) * j) / 4, 0)),
      );
  return most < FULL_FOG / 4;
}

async function fly(page: Page, backend: string, fogAwareDetail: boolean, haze: number): Promise<Run> {
  await openGlobe(
    page,
    `backend=${backend}&imagery=world&atmosphere=medium&clockStepMs=16.666666666666668&logSink=1&logLevel=debug` +
      '&lon=8&lat=45&zoom=12&tilt=85&heading=60',
  );
  await page.evaluate(
    ([on, hazeLevel]) => {
      const globe = window.vibeglobePlayground?.globe;
      globe?.setAtmosphere({ haze: hazeLevel });
      globe?.setQualitySettings({ fogAwareDetail: on });
    },
    [fogAwareDetail, haze] as const,
  );
  await waitForIdle(page);
  const before = await page.evaluate(() => {
    const hooks = window.vibeglobePlayground;
    const globe = hooks?.globe;
    hooks?.clearLog();
    // The eye at the end of every frame, with the page clock the log entries carry.
    const eyes: { timeMs: number; lon: number; lat: number; altitudeMeters: number }[] = [];
    (window as unknown as { fogEyes: typeof eyes }).fogEyes = eyes;
    globe?.on('frame', () => {
      const camera = globe.camera;
      eyes.push({
        timeMs: performance.now(),
        lon: camera.eyeLongitudeDeg,
        lat: camera.eyeLatitudeDeg,
        altitudeMeters: camera.altitudeMeters,
      });
    });
    return globe?.imageryStats()?.requested ?? 0;
  });
  const report = await page.evaluate(() => window.vibeglobePlayground?.recordScenario('tilted-flight', 0));
  if (!report) throw new Error('no report');
  await waitForIdle(page);
  const { stats, entries, eyes } = await page.evaluate(() => ({
    stats: window.vibeglobePlayground?.globe.imageryStats(),
    entries: window.vibeglobePlayground?.loggedEntries() ?? [],
    eyes: (window as unknown as { fogEyes: { timeMs: number; lon: number; lat: number; altitudeMeters: number }[] })
      .fogEyes,
  }));
  if (!stats) throw new Error('no stats');
  // A request logged while a frame is drawn belongs to the first eye recorded after it.
  const requests: Run['requests'] = [];
  for (const entry of entries) {
    const match = / request (\d+)\/(\d+)\/(\d+) at priority (-?[\d.e+-]+)$/.exec(entry.message);
    // One started after the last frame (a slot freed while the engine idles) belongs to the last frame's view.
    const eye = eyes.find((e) => e.timeMs >= entry.timeMs) ?? eyes.at(-1);
    if (match && eye)
      requests.push({
        level: Number(match[1]),
        x: Number(match[2]),
        y: Number(match[3]),
        priority: Number(match[4]),
        eye,
      });
  }
  const image = await canvasImage(page);
  const pixels: number[] = [];
  for (let i = 0; i < image.data.length; i += 4)
    pixels.push(image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0);
  return {
    requested: stats.requested - before,
    requests,
    gpuBytes: stats.gpuBytes,
    holes: report.holes,
    dark: report.dark,
    pixels,
  };
}

for (const backend of ['webgpu', 'webgl2'] as const)
  test(`fog-aware detail requests no fine tile inside full fog and fewer tiles in a tilted flight, with no visible difference in the fogged band, on ${backend} (F574)`, async ({
    page,
  }) => {
    // Two full flights at four times the haze: about 80 s each here, over 90 s each in CI's software GPU.
    test.setTimeout(420_000);
    const aware = await fly(page, backend, true, HAZE);
    const full = await fly(page, backend, false, HAZE);
    const saved = 1 - aware.requested / full.requested;
    // Requests of tiles whose parent lies entirely inside full fog: the selection would have refined a fogged tile.
    const inFog = aware.requests.filter((r) => r.level > 0 && entirelyFogged(r.level - 1, r.x >> 1, r.y >> 1, r.eye));
    const fullInFog = full.requests.filter(
      (r) => r.level > 0 && entirelyFogged(r.level - 1, r.x >> 1, r.y >> 1, r.eye),
    );
    // Requests of tiles the fog hides for the most part: where fog-aware detail saves its requests.
    const fogged = (run: Run): number => run.requests.filter((r) => centerFogged(r.level, r.x, r.y, r.eye)).length;
    // The fogged band: the rows between the horizon's sky and the near ground, the upper third of the frame.
    let difference = 0;
    let count = 0;
    for (let y = 40; y < 80; y++)
      for (let x = 0; x < 320; x++)
        for (let c = 0; c < 3; c++) {
          const i = (y * 320 + x) * 3 + c;
          difference += Math.abs((aware.pixels[i] ?? 0) - (full.pixels[i] ?? 0));
          count++;
        }
    console.log(
      `[fog-detail] ${backend}: ${aware.requested} vs ${full.requested} tiles requested (${(saved * 100).toFixed(1)}% fewer), ` +
        `${aware.requests.length} requests recorded, inside full fog ${inFog.length} (${inFog.map((r) => `${r.level}/${r.x}/${r.y} p${r.priority}`).join(' ')}; full detail ${fullInFog.length}), ` +
        `${fogged(aware)} vs ${fogged(full)} tiles mostly in fog, ` +
        `GPU ${aware.gpuBytes} vs ${full.gpuBytes} bytes, fogged band mean difference ${(difference / count).toFixed(2)}`,
    );
    // The record covers the run's requests, and the full-detail run shows the check finds fogged requests.
    expect(aware.requests.length).toBeGreaterThan(aware.requested * 0.9);
    expect(full.requests.length).toBeGreaterThan(full.requested * 0.9);
    expect(fullInFog.length).toBeGreaterThan(0);
    expect(inFog.map((r) => `${r.level}/${r.x}/${r.y}`)).toEqual([]);
    expect(fogged(aware)).toBeLessThan(fogged(full));
    expect(difference / count).toBeLessThan(2);
    expect([aware.holes, aware.dark, full.holes, full.dark]).toEqual([0, 0, 0, 0]);
  });
