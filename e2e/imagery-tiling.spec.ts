import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, openGlobe } from './support/globe.ts';
import { fixtureSession, requestLog, waitForStreaming } from './support/imagery.ts';
import { worldColor } from '../scripts/fixtures/tiles/generate.ts';

/**
 * Tile placement of both tiling schemes (F224, F225): the fixture `world` imagery draws a dark one-texel grid line
 * every eighth of a tile, in the texel just west of (or north of) the line, so each line's projected position is known.
 * Measured across the line, the dark band's centroid must lie within half a pixel of that position. Screenshots of the
 * same views are compared with baselines in e2e/visual.spec.ts (views tiling-*).
 */
const BACKENDS = ['webgpu', 'webgl2'] as const;
const TILE_PX = 256;
const MAX_ERROR_PX = 0.5;

test.use({ viewport: { width: 320, height: 240 } });

type Scheme = 'mercator' | 'geographic';

/** The views of each scheme: globe, flat map and tilted for Web Mercator; the antimeridian and both poles for 4326. */
const VIEWS: Record<Scheme, readonly { name: string; query: string }[]> = {
  // Globe views draw surface tiles of level 4 at least (`level=`): a coarser tile's flat triangles sag below the ellipsoid
  // by up to the surface's own error budget (1 px), which is not tile placement.
  // Capped one level below the view's own, the tiles show magnified: a minified one-texel line is averaged with its
  // neighbors by mipmapping, which moves its centroid by design.
  mercator: [
    { name: 'globe', query: 'lon=10&lat=30&zoom=2&imageryMax=2&level=4' },
    { name: '2d', query: 'viewMode=2d&lon=10&lat=50&zoom=5&imageryMax=5' },
    { name: '3d', query: 'viewMode=3d&lon=10&lat=45&zoom=6&tilt=40&imageryMax=5' },
    { name: '2d-85', query: 'viewMode=2d&lon=-60&lat=83.5&zoom=5&imageryMax=5' },
    // TMS rows counted from the south (F229).
    { name: 'globe-tms', query: 'lon=10&lat=30&zoom=2&imageryMax=2&level=4&imageryAddressing=tms' },
    { name: '2d-tms', query: 'viewMode=2d&lon=10&lat=50&zoom=5&imageryMax=5&imageryAddressing=tms' },
  ],
  geographic: [
    { name: 'globe-antimeridian', query: 'lon=180&lat=10&zoom=2.3&imageryMax=1&level=4' },
    { name: 'globe-north', query: 'lon=30&lat=88&zoom=2.3&imageryMax=1&level=4' },
    { name: 'globe-south', query: 'lon=-150&lat=-88&zoom=2.3&imageryMax=1&level=4' },
    { name: '2d-antimeridian', query: 'viewMode=2d&lon=180&lat=40&zoom=5.3' },
  ],
};

interface Tile {
  west: number;
  south: number;
  east: number;
  north: number;
  level: number | null;
}

/** Width of an imagery tile of a level, in degrees of longitude. */
function tileWidthDeg(scheme: Scheme, level: number): number {
  return (scheme === 'mercator' ? 360 : 180) / 2 ** level;
}

/** Latitude of a fractional imagery tile row (rows from the north). */
function rowLatDeg(scheme: Scheme, level: number, row: number): number {
  if (scheme === 'geographic') return 90 - (180 * row) / 2 ** level;
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / 2 ** level))) * 180) / Math.PI;
}

/** Fractional imagery tile row of a latitude. */
function latRow(scheme: Scheme, level: number, latDeg: number): number {
  if (scheme === 'geographic') return ((90 - latDeg) / 180) * 2 ** level;
  const lat = (latDeg * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * 2 ** level;
}

/** Luminance of a canvas point, bilinear between pixel centers. */
function luminanceAt(image: PNG, xPx: number, yPx: number): number {
  const x = xPx - 0.5;
  const y = yPx - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  let sum = 0;
  for (const [dx, dy] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const) {
    const px = Math.min(image.width - 1, Math.max(0, x0 + dx));
    const py = Math.min(image.height - 1, Math.max(0, y0 + dy));
    const w = (dx ? x - x0 : 1 - (x - x0)) * (dy ? y - y0 : 1 - (y - y0));
    const i = (py * image.width + px) * 4;
    sum += w * (0.299 * (image.data[i] ?? 0) + 0.587 * (image.data[i + 1] ?? 0) + 0.114 * (image.data[i + 2] ?? 0));
  }
  return sum;
}

/**
 * Signed distance from `at` to the dark band's centroid along the unit normal `n`, or undefined where no clear line
 * shows (a crossing line or the limb in the reference samples).
 */
function centroidOffsetPx(image: PNG, at: { xPx: number; yPx: number }, n: [number, number]): number | undefined {
  const sample = (s: number): number => luminanceAt(image, at.xPx + s * n[0], at.yPx + s * n[1]);
  const sides = [-4, -3.5, -3, 3, 3.5, 4].map(sample);
  const baseline = sides.reduce((a, b) => a + b, 0) / sides.length;
  if (Math.max(...sides) - Math.min(...sides) > 40) return undefined;
  let weight = 0;
  let moment = 0;
  let peak = 0;
  for (let s = -2; s <= 2; s += 0.125) {
    const dark = Math.max(0, baseline - sample(s));
    peak = Math.max(peak, dark);
    weight += dark;
    moment += dark * s;
  }
  return peak < 25 ? undefined : moment / weight;
}

interface Probe {
  /** The dark texel's center on the line, and the points one texel further along and across the line. */
  at: { longitudeDeg: number; latitudeDeg: number };
  along: { longitudeDeg: number; latitudeDeg: number };
  across: { longitudeDeg: number; latitudeDeg: number };
}

/**
 * Points along the grid lines inside each surface tile, at the imagery level the tile shows and at the texel centers
 * the lines are drawn on: half a texel west of a meridian, half a texel north of a parallel.
 */
function probes(scheme: Scheme, tiles: Tile[]): Probe[] {
  const result: Probe[] = [];
  const steps = 24;
  for (const tile of tiles) {
    if (tile.level === null) continue;
    const level = tile.level;
    const spacingDeg = tileWidthDeg(scheme, level) / 8;
    const texelDeg = tileWidthDeg(scheme, level) / TILE_PX;
    // A texel's height in latitude: Web Mercator's shrinks with the cosine of the latitude.
    const texelLatDeg = (lat: number): number =>
      scheme === 'mercator' ? texelDeg * Math.cos((lat * Math.PI) / 180) : texelDeg;
    const south = Math.max(-89.5, tile.south);
    const north = Math.min(89.5, tile.north);
    for (let k = Math.ceil((tile.west + 180) / spacingDeg); -180 + k * spacingDeg <= tile.east; k++) {
      const lon = -180 + k * spacingDeg - texelDeg / 2;
      if (lon < tile.west) continue;
      for (let s = 0.5; s < steps; s++) {
        const lat = south + ((north - south) * s) / steps;
        result.push({
          at: { longitudeDeg: lon, latitudeDeg: lat },
          along: { longitudeDeg: lon, latitudeDeg: lat - texelLatDeg(lat) },
          across: { longitudeDeg: lon + texelDeg, latitudeDeg: lat },
        });
      }
    }
    for (let r = Math.ceil(latRow(scheme, level, north) * 8); r <= Math.floor(latRow(scheme, level, south) * 8); r++) {
      const lat = rowLatDeg(scheme, level, r / 8 - 0.5 / TILE_PX);
      if (lat > north) continue;
      for (let s = 0.5; s < steps; s++) {
        const lon = tile.west + ((tile.east - tile.west) * s) / steps;
        result.push({
          at: { longitudeDeg: lon, latitudeDeg: lat },
          along: { longitudeDeg: lon + texelDeg, latitudeDeg: lat },
          across: { longitudeDeg: lon, latitudeDeg: lat - texelLatDeg(lat) },
        });
      }
    }
  }
  return result;
}

/** Errors of every grid-line probe that shows a clear line where texels are magnified, in pixels. */
async function gridErrors(page: Page, scheme: Scheme): Promise<number[]> {
  const tiles = await page.evaluate(() =>
    (window.vibeglobePlayground?.globe.surfaceTiles() ?? []).map((t) => ({
      west: t.westDeg,
      south: t.southDeg,
      east: t.eastDeg,
      north: t.northDeg,
      level: t.imageryLevel,
    })),
  );
  const list = probes(scheme, tiles);
  // Positions behind the globe project too: keep those whose screen point picks them back.
  const points = await page.evaluate(
    (positions) =>
      positions.map((p) => {
        const globe = window.vibeglobePlayground?.globe;
        const point = globe?.geoToScreen(p);
        const back = point && globe?.screenToGeo(point);
        const seen =
          back &&
          Math.abs(((((back.longitudeDeg - p.longitudeDeg) % 360) + 540) % 360) - 180) +
            Math.abs(back.latitudeDeg - p.latitudeDeg);
        return seen !== undefined && seen < 1e-3 ? point : null;
      }),
    // A step of a texel from a point near a pole can pass it: stop at the pole.
    list.flatMap((p) =>
      [p.at, p.along, p.across].map((q) => ({ ...q, latitudeDeg: Math.max(-90, Math.min(90, q.latitudeDeg)) })),
    ),
  );
  const image = await canvasImage(page);
  const errors: number[] = [];
  for (let i = 0; i < list.length; i++) {
    const at = points[3 * i];
    const along = points[3 * i + 1];
    const across = points[3 * i + 2];
    if (!at || !along || !across) continue;
    if (at.xPx < 6 || at.yPx < 6 || at.xPx > image.width - 6 || at.yPx > image.height - 6) continue;
    const tx = along.xPx - at.xPx;
    const ty = along.yPx - at.yPx;
    const length = Math.hypot(tx, ty);
    // Where a texel shows smaller than a pixel, mipmapping averages the one-texel line with its neighbors and moves its
    // centroid by design (up to half a pixel toward the texel's neighbors): measure where texels are magnified.
    if (length < 1.2 || Math.hypot(across.xPx - at.xPx, across.yPx - at.yPx) < 1.2) continue;
    const offset = centroidOffsetPx(image, at, [-ty / length, tx / length]);
    if (offset !== undefined) errors.push(Math.abs(offset));
  }
  return errors;
}

/** Pixels whose channels are all near zero: no fixture tile, background or line is that dark. */
function blackPixels(image: PNG): number {
  let count = 0;
  for (let i = 0; i < image.data.length; i += 4)
    if ((image.data[i] ?? 0) <= 8 && (image.data[i + 1] ?? 0) <= 8 && (image.data[i + 2] ?? 0) <= 8) count++;
  return count;
}

for (const backend of BACKENDS) {
  test.describe(backend, () => {
    for (const scheme of ['mercator', 'geographic'] as const) {
      for (const view of VIEWS[scheme]) {
        const feature = view.name.endsWith('tms') ? 'F229' : scheme === 'mercator' ? 'F224' : 'F225';
        test(`${scheme} tiles' grid lines land within half a pixel of their projected positions, ${view.name}, on ${backend} (${feature})`, async ({
          page,
        }) => {
          test.setTimeout(120_000);
          await openGlobe(page, `backend=${backend}&imagery=world&imageryTiling=${scheme}&${view.query}`);
          await waitForStreaming(page);
          const errors = await gridErrors(page, scheme);
          const worst = Math.max(...errors);
          console.log(
            `[tiling] ${backend} ${scheme} ${view.name}: ${errors.length} probes, worst ${worst.toFixed(3)} px`,
          );
          expect(errors.length).toBeGreaterThan(50);
          expect(worst).toBeLessThanOrEqual(MAX_ERROR_PX);
          if (scheme === 'geographic') expect(blackPixels(await canvasImage(page))).toBe(0);
        });
      }
    }

    test(`geographic imagery stacked above Web Mercator imagery aligns with it on ${backend} (F225)`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      const view = `backend=${backend}&lon=170&lat=40&zoom=4.3`;
      const frames: PNG[] = [];
      for (const query of [
        `imagery=world`,
        `imagery=world&imageryTiling=geographic`,
        `imagery=world&overlays=world:0.5&overlayTiling=geographic`,
      ]) {
        await openGlobe(page, `${view}&${query}`);
        await waitForStreaming(page);
        frames.push(await canvasImage(page));
      }
      const [mercator, geographic, stacked] = frames;
      if (!mercator || !geographic || !stacked) throw new Error('missing frame');
      // Aligned, the half-transparent geographic layer over the Web Mercator one blends to their average in linear light
      // everywhere, grid lines included; a placement error of a pixel doubles the lines and fails a few percent of the
      // pixels.
      const linear = (v: number): number => (v / 255) ** 2.2;
      let differing = 0;
      for (let i = 0; i < stacked.data.length; i += 4)
        for (let c = 0; c < 3; c++) {
          const mean =
            255 * ((linear(mercator.data[i + c] ?? 0) + linear(geographic.data[i + c] ?? 0)) / 2) ** (1 / 2.2);
          if (Math.abs((stacked.data[i + c] ?? 0) - mean) > 12) {
            differing++;
            break;
          }
        }
      expect(differing / (stacked.width * stacked.height)).toBeLessThan(0.002);
    });

    test(`a source shows the same placement, colors, credits and requests at the end of the globe phase, in 2D and in 3D on ${backend} (F250)`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      const phases = [
        { phase: 'globe', query: 'zoom=3.7&imageryMax=4&level=4' },
        { phase: '2d', query: 'zoom=7&imageryMax=7' },
        { phase: '3d', query: 'zoom=16.8&imageryMax=16' },
      ];
      for (const { phase, query } of phases) {
        const session = await fixtureSession(page);
        await openGlobe(page, `backend=${backend}&session=${session}&imagery=world&lon=10&lat=30&${query}`);
        await waitForStreaming(page);
        expect(await page.evaluate(() => window.vibeglobePlayground?.globe.camera.phase)).toBe(phase);
        // Placement: the grid lines, the source's ground control marks, within half a pixel.
        const errors = await gridErrors(page, 'mercator');
        console.log(
          `[phases] ${backend} ${phase}: ${errors.length} probes, worst ${Math.max(...errors).toFixed(3)} px`,
        );
        expect(errors.length).toBeGreaterThan(50);
        expect(Math.max(...errors)).toBeLessThanOrEqual(MAX_ERROR_PX);
        // Colors: away from the grid lines, each sampled pixel shows the fixture's color at its position.
        const image = await canvasImage(page);
        const samples = await page.evaluate(
          ({ width, height }) => {
            const points = [];
            for (let y = 8; y < height; y += 16)
              for (let x = 8; x < width; x += 16)
                points.push({ x, y, geo: window.vibeglobePlayground?.globe.screenToGeo({ xPx: x, yPx: y }) });
            return points;
          },
          { width: image.width, height: image.height },
        );
        const differences: number[] = [];
        for (const { x, y, geo } of samples) {
          const i = (Math.floor(y) * image.width + Math.floor(x)) * 4;
          const shown = [image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0];
          if (!geo || Math.max(...shown) < 60) continue;
          const expected = worldColor((geo.longitudeDeg * Math.PI) / 180, (geo.latitudeDeg * Math.PI) / 180);
          differences.push(Math.max(...shown.map((value, c) => Math.abs(value - (expected[c] ?? 0)))));
        }
        differences.sort((a, b) => a - b);
        const median = differences[Math.floor(differences.length / 2)] ?? 255;
        console.log(`[phases] ${backend} ${phase}: color difference median ${median} over ${differences.length}`);
        expect(differences.length).toBeGreaterThan(100);
        expect(median).toBeLessThanOrEqual(6);
        // Credits and requests: the same credit, and every tile from the same template, each drawn one requested.
        expect(await page.evaluate(() => window.vibeglobePlayground?.globe.credits().map((c) => c.text))).toEqual([
          'Fixture world',
        ]);
        const log = await requestLog(page, session);
        const template = new RegExp(`^/fixture-tiles/${session}/world/mercator/\\d+/\\d+/\\d+\\.png$`);
        expect(log.filter((request) => !template.test(request.path)).map((r) => r.path)).toEqual([]);
        expect(log.filter((request) => request.status !== 200).length).toBe(0);
      }
    });
  });
}
