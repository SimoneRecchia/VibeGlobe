import { fc, test } from '@fast-check/vitest';
import { WEB_MERCATOR_TILING, type TileRequest, type TransportResult } from '@vibeglobe/core';
import { transformCoordinates } from '@vibeglobe/gis';
import { describe, expect, it } from 'vitest';
import { reprojectedImagery, type WarpImage } from './reprojected-imagery.js';
import { applyAffine, planWarp, solveAffine, tilePointLonLat, type SourceBbox, type Triangle } from './warp-math.js';
import { wmsGetMapUrl } from './wms-get-map.js';

// proj4 (through @vibeglobe/gis) is the reference projection library.
const toUtm32 = (lon: number, lat: number): [number, number] => {
  const p = transformCoordinates({ x: lon, y: lat }, 'EPSG:4326', 'EPSG:32632');
  return [p.x, p.y];
};
const fromUtm32 = (x: number, y: number): [number, number] => {
  const p = transformCoordinates({ x, y }, 'EPSG:32632', 'EPSG:4326');
  return [p.x, p.y];
};
/** Zone 32N around 6°E–12°E, 36°N–47.5°N, in meters. */
const BOUNDS: SourceBbox = [250_000, 3_980_000, 770_000, 5_270_000];
const TIMEOUTS = { firstByteMs: 1000, totalMs: 1000 };

describe('reprojection math (F226)', () => {
  it('solves the affine map that takes three points onto three others exactly', () => {
    const from: Triangle = [10, 20, 300, 40, 50, 260];
    const to: Triangle = [0, 0, 256, 0, 0, 256];
    const m = solveAffine(from, to);
    if (!m) throw new Error('degenerate');
    for (let k = 0; k < 6; k += 2) {
      const [x, y] = applyAffine(m, from[k] ?? 0, from[k + 1] ?? 0);
      expect(x).toBeCloseTo(to[k] ?? 0, 9);
      expect(y).toBeCloseTo(to[k + 1] ?? 0, 9);
    }
    expect(solveAffine([0, 0, 1, 1, 2, 2], to)).toBeUndefined();
  });

  test.prop([fc.double({ min: 3, max: 15, noNaN: true }), fc.double({ min: 30, max: 60, noNaN: true })])(
    'round-trips lon/lat through UTM 32N within 1e-6°',
    (lon, lat) => {
      const [x, y] = toUtm32(lon, lat);
      const [lon2, lat2] = fromUtm32(x, y);
      expect(Math.abs(lon2 - lon)).toBeLessThan(1e-6);
      expect(Math.abs(lat2 - lat)).toBeLessThan(1e-6);
    },
  );

  test.prop(
    [
      fc.integer({ min: 7, max: 14 }),
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.double({ min: 0, max: 1, noNaN: true }),
    ],
    {
      numRuns: 40,
    },
  )('warps tile pixels onto the source pixels proj4 gives, within a tenth of a pixel', (level, u, v) => {
    const coord = WEB_MERCATOR_TILING.tileAt((9 * Math.PI) / 180, (43 * Math.PI) / 180, level, {
      root: 0,
      level,
      x: 0,
      y: 0,
    });
    const extent = WEB_MERCATOR_TILING.tileExtent(coord, { westRad: 0, southRad: 0, eastRad: 0, northRad: 0 });
    const plan = planWarp({ extent, tiling: 'mercator', tileSizePx: 256, toSource: toUtm32, bounds: BOUNDS });
    if (!plan) throw new Error('no plan');
    const cell = 256 / 16;
    const [px, py] = [u * 256, v * 256];
    // Levels 7+ lie inside the bounds, so no triangle is skipped. The triangle holding the point: cells split along
    // the diagonal from top-right to bottom-left.
    const [i, j] = [Math.min(15, Math.floor(px / cell)), Math.min(15, Math.floor(py / cell))];
    const upper = px - i * cell + (py - j * cell) <= cell;
    const triangle = plan.triangles[(j * 16 + i) * 2 + (upper ? 0 : 1)];
    if (!triangle) throw new Error('missing triangle');
    // Invert the triangle's map (source → tile) to find the source pixel the tile pixel shows.
    const [a, b, c, d, e, f] = triangle.transform;
    const det = a * d - b * c;
    const sx = (d * (px - e) - c * (py - f)) / det;
    const sy = (-b * (px - e) + a * (py - f)) / det;
    const [lon, lat] = tilePointLonLat(extent, 'mercator', u, v);
    const [x, y] = toUtm32(lon, lat);
    const [w, s, east, n] = plan.imageBbox;
    const exactX = ((x - w) / (east - w)) * plan.imageWidthPx;
    const exactY = ((n - y) / (n - s)) * plan.imageHeightPx;
    expect(Math.hypot(sx - exactX, sy - exactY)).toBeLessThan(0.1);
  });
});

describe('reprojectedImagery (F226)', () => {
  const requested: string[] = [];
  const warp: WarpImage = () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer);
  const source = reprojectedImagery({
    id: 'utm',
    sourceCrs: 'EPSG:32632',
    toSource: toUtm32,
    fromSource: fromUtm32,
    bounds: BOUNDS,
    image: (bbox, width, height) => `https://wms.test/map?${bbox.join(',')}&${width}x${height}`,
    maxLevel: 16,
    warpImage: warp,
    transport: {
      start(request, _timeouts, done) {
        requested.push(request.url);
        setTimeout(() => done({ kind: 'ok', bytes: new ArrayBuffer(8), contentType: 'image/png' }), 0);
        return () => undefined;
      },
    },
  });
  const out: TileRequest = { url: '', hostIndex: -1 };

  it('answers noData outside the bounds and the levels, a pseudo URL inside', () => {
    const tile = (lonDeg: number, latDeg: number, level: number): ReturnType<typeof source.request> =>
      source.request(
        WEB_MERCATOR_TILING.tileAt((lonDeg * Math.PI) / 180, (latDeg * Math.PI) / 180, level, {
          root: 0,
          level,
          x: 0,
          y: 0,
        }),
        out,
      );
    expect(tile(-40, 40, 8)).toBe('noData');
    expect(tile(9, 60, 8)).toBe('noData');
    expect(tile(9, 43, 17)).toBe('noData');
    expect(tile(9, 43, 8)).toBe(out);
    expect(out).toEqual({ url: 'reproject:utm/8/134/94', hostIndex: 0 });
  });

  it('fetches one source image covering the tile and answers the warped PNG', async () => {
    requested.length = 0;
    source.request({ root: 0, level: 10, x: 537, y: 374 }, out);
    const result = await new Promise<TransportResult>((resolve) => source.transport.start(out, TIMEOUTS, resolve));
    expect(result).toEqual({ kind: 'ok', bytes: new Uint8Array([1, 2, 3]).buffer, contentType: 'image/png' });
    expect(requested).toHaveLength(1);
    const size = /&(\d+)x(\d+)$/.exec(requested[0] ?? '');
    expect(Number(size?.[1])).toBeGreaterThan(200);
    expect(Number(size?.[1])).toBeLessThanOrEqual(512);
  });

  it('reports an abort exactly once', () => {
    source.request({ root: 0, level: 10, x: 537, y: 374 }, out);
    const results: TransportResult[] = [];
    const abort = source.transport.start(out, TIMEOUTS, (r) => results.push(r));
    abort();
    abort();
    expect(results).toEqual([{ kind: 'aborted' }]);
  });
});

describe('wmsGetMapUrl', () => {
  it('writes the BBOX latitude first for EPSG:4326 and easting first for UTM', () => {
    const common = { layers: ['ortho'], widthPx: 256, heightPx: 128 } as const;
    expect(wmsGetMapUrl('https://x.test/wms', { ...common, crs: 'EPSG:4326', bbox: [6, 36, 12, 47.5] })).toBe(
      'https://x.test/wms?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=ortho&STYLES=&FORMAT=image%2Fpng' +
        '&TRANSPARENT=TRUE&CRS=EPSG%3A4326&WIDTH=256&HEIGHT=128&BBOX=36,6,47.5,12',
    );
    expect(
      wmsGetMapUrl('https://x.test/wms?map=a', {
        ...common,
        crs: 'EPSG:32632',
        bbox: [250000, 3980000, 770000, 5270000],
      }),
    ).toMatch(/^https:\/\/x\.test\/wms\?map=a&SERVICE=WMS.*&CRS=EPSG%3A32632&.*&BBOX=250000,3980000,770000,5270000$/);
  });
});
