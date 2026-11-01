import { geodeticToEcef, type TileRequest, type TileTransport, type TransportResult } from '@vibeglobe/core';
import { describe, expect, it, vi } from 'vitest';
import { encodeMvt } from '../__fixtures__/mvt-writer.js';
import { fillArea, tessellateFill, tileClipRect } from './fill-tessellate.js';
import { globeVertices, maxEdgeUnits, subdividedFill, tileOrigin, tileToLonLat } from './globe-vertices.js';
import { BUCKET_BUFFER, BUCKET_EXTENT, layoutVectorTile } from './layout-tile.js';
import { StyleLayer } from './style-layer.js';
import { bucketVersion, VectorTileLoader } from './tile-loader.js';
import { backgroundBucket, meshGeometry } from './tile-meshes.js';
import { tileKey, type TileId } from './tile-pyramid.js';
import { meshPaint, zoomBracket } from './vector-paint.js';
import { sampledTiles, viewTargets } from './view-tiles.js';

const TILE = encodeMvt({
  water: [
    {
      id: 1,
      type: 'Polygon',
      geometry: [
        [
          [0, 0],
          [4096, 0],
          [4096, 4096],
          [0, 4096],
          [0, 0],
        ],
      ],
      properties: {},
    },
  ],
  roads: [
    {
      id: 2,
      type: 'LineString',
      geometry: [
        [
          [0, 2048],
          [4096, 2048],
        ],
      ],
      properties: { class: 'primary' },
    },
  ],
  poi: [{ id: 3, type: 'Point', geometry: [[[1000, 1000]]], properties: { class: 'dot' } }],
});

const ecef = (lon: number, lat: number) => {
  const out = new Float64Array(3);
  geodeticToEcef((lon * Math.PI) / 180, (lat * Math.PI) / 180, 0, out);
  return out;
};

describe('globe placement of vector tiles (F441)', () => {
  it('maps tile units to the Web Mercator square of the tile', () => {
    expect(tileToLonLat({ z: 0, x: 0, y: 0 }, 4096, 0, 0)).toEqual([-180, expect.closeTo(85.0511, 3)]);
    expect(tileToLonLat({ z: 1, x: 1, y: 1 }, 4096, 0, 0)).toEqual([0, 0]);
  });

  it('places a vertex on the ellipsoid relative to the tile origin, the same from both tiles of an edge', () => {
    const xy = new Float32Array([4096, 1000]);
    const left = globeVertices({ z: 6, x: 33, y: 22 }, 4096, xy, 2);
    const right = globeVertices({ z: 6, x: 34, y: 22 }, 4096, new Float32Array([0, 1000]), 2);
    const [lon, lat] = tileToLonLat({ z: 6, x: 33, y: 22 }, 4096, 4096, 1000);
    const expected = ecef(lon ?? 0, lat ?? 0);
    for (const [tile, v] of [
      [{ z: 6, x: 33, y: 22 }, left],
      [{ z: 6, x: 34, y: 22 }, right],
    ] as const) {
      const origin = tileOrigin(tile).originEcef;
      for (let i = 0; i < 3; i++) expect((origin[i] ?? 0) + (v.positions[i] ?? 0)).toBeCloseTo(expected[i] ?? 0, 0);
    }
  });

  it('splits fills and lines at low zoom only, keeping the filled area', () => {
    expect(maxEdgeUnits(0, 4096)).toBeLessThan(50);
    expect(maxEdgeUnits(14, 4096)).toBe(Infinity);
    const rings = [
      [
        [0, 0],
        [4096, 0],
        [0, 4096],
        [0, 0],
      ] as [number, number][],
    ];
    const clip = tileClipRect(4096, 128);
    const split = subdividedFill(rings, clip, 512);
    expect(fillArea(split)).toBeCloseTo(fillArea(tessellateFill(rings, clip)), 0);
    expect(split.indices.length / 3).toBeGreaterThan(36);
  });

  it('lays out with globe attributes and side points for lines', () => {
    const layers = [
      { id: 'water', type: 'fill', source: 's', 'source-layer': 'water', paint: { 'fill-color': '#00f' } },
      { id: 'roads', type: 'line', source: 's', 'source-layer': 'roads', paint: { 'line-width': 2 } },
    ];
    const buckets = layoutVectorTile({ bytes: TILE, layers, zoom: 2, tile: { z: 2, x: 1, y: 1 } });
    const fill = buckets.find((b) => b.layerId === 'water')?.geometry;
    const line = buckets.find((b) => b.layerId === 'roads')?.geometry;
    // Zoom 2 splits the square into cells: more than two triangles.
    expect((fill?.indices.length ?? 0) / 3).toBeGreaterThan(2);
    expect(fill?.globe?.positions.length).toBe(((fill?.positions.length ?? 0) / 2) * 3);
    expect(line?.side?.planes.length).toBe(((line?.positions.length ?? 0) / 2) * 4);
  });

  it('keeps a symbol with an icon and no text, with its sprite icon (F448)', () => {
    const layers = [
      { id: 'poi', type: 'symbol', source: 's', 'source-layer': 'poi', layout: { 'icon-image': ['get', 'class'] } },
    ];
    const [bucket] = layoutVectorTile({ bytes: TILE, layers, zoom: 2 });
    expect(bucket?.labels).toEqual([{ feature: 0, text: '', anchor: [1000, 1000], icon: 'dot' }]);
  });
});

describe('vector tiles of a view (F441, F442)', () => {
  const covers = (targets: readonly TileId[], z: number, x: number, y: number) =>
    targets.filter((t) => t.z <= z && Math.floor(x / 2 ** (z - t.z)) === t.x && Math.floor(y / 2 ** (z - t.z)) === t.y);

  it('partitions mixed levels: every square is drawn by exactly one target', () => {
    const surface = [
      { root: 'mercator', level: 4, x: 8, y: 5 },
      { root: 'mercator', level: 6, x: 32, y: 20 },
      { root: 'north-cap', level: 1, x: 0, y: 0 },
    ];
    const targets = viewTargets(surface);
    for (let x = 0; x < 16; x++)
      for (let y = 0; y < 16; y++) {
        const inside = x < 4 && y < 4;
        expect(covers(targets, 5, 16 + x, 8 + y).length).toBe(inside ? 1 : 0);
      }
    expect(targets.some((t) => tileKey(t) === '5/16/10')).toBe(true);
  });

  it('refines where screen samples ask for detail', () => {
    // A flat view: 1/2^14 of the world per 512 px everywhere, around (0.5, 0.5).
    const sampler = {
      screenToGeo: ({ xPx, yPx }: { xPx: number; yPx: number }) => {
        const k = 1 / (512 * 2 ** 14);
        const wx = 0.5 + (xPx - 320) * k;
        const wy = 0.5 + (yPx - 240) * k;
        return {
          longitudeDeg: wx * 360 - 180,
          latitudeDeg: (Math.atan(Math.sinh(Math.PI * (1 - 2 * wy))) * 180) / Math.PI,
        };
      },
    };
    let picks = 0;
    const tiles = sampledTiles({ screenToGeo: (point) => (picks++, sampler.screenToGeo(point)) }, 640, 480);
    expect(new Set(tiles.map((t) => t.z))).toEqual(new Set([14]));
    // One pick per sample of the 13 × 10 grid: the scale comes from the neighbors (KB-210).
    expect(picks).toBe(130);
  });

  it('measures the scale across the antimeridian the short way, asking for no coarse tile there', () => {
    // A zoom-14 view centered on 180°: the screen's left half is east of the line, its right half west of it.
    const k = 1 / (512 * 2 ** 14);
    const tiles = sampledTiles(
      {
        screenToGeo: ({ xPx, yPx }) => {
          const wx = (1 + (xPx - 320) * k + 1) % 1;
          const wy = 0.5 + (yPx - 240) * k;
          return {
            longitudeDeg: wx * 360 - 180,
            latitudeDeg: (Math.atan(Math.sinh(Math.PI * (1 - 2 * wy))) * 180) / Math.PI,
          };
        },
      },
      640,
      480,
    );
    expect(new Set(tiles.map((t) => t.z))).toEqual(new Set([14]));
  });
});

describe('paint and meshes (F440, F450)', () => {
  it('evaluates paint at the two zooms around the camera', () => {
    const layer = new StyleLayer({
      id: 'r',
      type: 'line',
      source: 's',
      'source-layer': 'roads',
      paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 2, 12, 6], 'line-color': '#ff0000' },
    });
    const { zoomA, t } = zoomBracket(10.25);
    expect([zoomA, t]).toEqual([10, 0.25]);
    const paint = meshPaint(
      layer,
      { features: [{ id: 1, type: 'LineString', properties: {} }] },
      new Uint32Array([0, 0]),
      zoomA,
      () => undefined,
    );
    // Half widths at zoom 10 and 11.
    expect([paint.paramsA[0], paint.paramsB[0], paint.paramsA[4]]).toEqual([1, 2, 1]);
    expect(Array.from(paint.colorA.slice(0, 4))).toEqual([1, 0, 0, 1]);
  });

  it('builds a background square that follows the globe', () => {
    const bucket = backgroundBucket({ z: 0, x: 0, y: 0 }, 'bg');
    const mesh = meshGeometry('fill', bucket, tileOrigin({ z: 0, x: 0, y: 0 }));
    expect(mesh?.data.indices.length).toBeGreaterThan(1000);
    // Past the square by the buffer: the draw's clip decides.
    expect(mesh?.data.tile[0]).toBe(-BUCKET_BUFFER);
    expect(mesh?.data.tile.at(-1)).toBe(BUCKET_EXTENT + BUCKET_BUFFER);
  });
});

/** A transport answering from a table of URLs; unknown URLs are 404. */
function fakeTransport(table: Record<string, ArrayBuffer | 'html'>): TileTransport & { started: string[] } {
  const started: string[] = [];
  return {
    started,
    start(request: TileRequest, _timeouts, done: (result: TransportResult) => void) {
      started.push(request.url);
      const body = table[request.url];
      queueMicrotask(() =>
        done(
          body === undefined
            ? { kind: 'status', status: 404, retryAfterMs: undefined }
            : body === 'html'
              ? { kind: 'ok', bytes: new ArrayBuffer(10), contentType: 'text/html' }
              : { kind: 'ok', bytes: body.slice(0), contentType: 'application/x-protobuf' },
        ),
      );
      return () => undefined;
    },
  };
}

describe('tile loading (F442, F450)', () => {
  const layers = [{ id: 'water', type: 'fill', source: 's', 'source-layer': 'water', paint: {} }];
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('loads and lays out tiles, marks 404 and HTML answers missing, and lays out again without downloading', async () => {
    const transport = fakeTransport({ a: TILE, html: 'html' });
    const loader = new VectorTileLoader({ transport, onReady: () => undefined });
    loader.setLayers(layers, 1);
    const tiles = { a: { z: 1, x: 0, y: 0 }, b: { z: 1, x: 1, y: 0 }, html: { z: 1, x: 0, y: 1 } };
    loader.update(
      Object.entries(tiles).map(([url, tile], priority) => ({ url, tile, priority })),
      new Set(),
    );
    await tick();
    expect(loader.get(tiles.a)?.buckets[0]?.layerId).toBe('water');
    expect(loader.isMissing(tiles.b)).toBe(true);
    expect(loader.isMissing(tiles.html)).toBe(true);
    loader.setLayers([{ ...layers[0], id: 'water2' } as (typeof layers)[0]], 2);
    await tick();
    expect(loader.get(tiles.a)?.buckets[0]?.layerId).toBe('water2');
    expect(loader.requestLog).toEqual(['a', 'b', 'html']);
  });

  it('lays out again only the layer whose filter or layout changed, keeping the others and their versions (TD-02)', async () => {
    const transport = fakeTransport({ a: TILE });
    const loader = new VectorTileLoader({ transport, onReady: () => undefined });
    const two = [
      { id: 'water', type: 'fill', source: 's', 'source-layer': 'water' },
      { id: 'roads', type: 'line', source: 's', 'source-layer': 'roads' },
    ] as typeof layers;
    loader.setLayers(two, 1);
    const tile = { z: 1, x: 0, y: 0 };
    loader.update([{ url: 'a', tile, priority: 0 }], new Set());
    await tick();
    const first = loader.get(tile);
    const roads = first?.buckets.find((b) => b.layerId === 'roads');
    // The roads' filter now drops every feature: only the roads are laid out again.
    const filtered = [two[0], { ...two[1], filter: ['==', ['get', 'class'], 'none'] }] as typeof layers;
    loader.setLayers(filtered, 2, new Set(['roads']));
    await tick();
    const second = loader.get(tile);
    if (!first || !second) throw new Error('not laid out');
    expect(second.version).toBe(2);
    expect(second.buckets.find((b) => b.layerId === 'water')).toBe(first.buckets.find((b) => b.layerId === 'water'));
    expect(second.buckets.find((b) => b.layerId === 'roads')).not.toBe(roads);
    expect(bucketVersion(second, 'water')).toBe(1);
    expect(bucketVersion(second, 'roads')).toBe(2);
    // Then the water, kept the first time: its bucket takes the new version, the roads keep theirs.
    loader.setLayers(
      [{ ...two[0], filter: ['==', ['get', 'class'], 'none'] }, filtered[1]] as typeof layers,
      3,
      new Set(['water']),
    );
    await tick();
    const third = loader.get(tile);
    if (!third) throw new Error('not laid out');
    expect(bucketVersion(third, 'water')).toBe(3);
    expect(bucketVersion(third, 'roads')).toBe(2);
    // A new order of the layers lays out every layer.
    loader.setLayers([filtered[1], filtered[0]] as typeof layers, 4);
    await tick();
    const fourth = loader.get(tile);
    if (!fourth) throw new Error('not laid out');
    expect(bucketVersion(fourth, 'water')).toBe(4);
    expect(fourth.buckets.find((b) => b.layerId === 'water')).not.toBe(
      third.buckets.find((b) => b.layerId === 'water'),
    );
    expect(loader.requestLog).toEqual(['a']);
  });

  it('takes the answer of a transport that answers before it returns (a cache, a failure on the spot)', async () => {
    const answers: TransportResult[] = [
      { kind: 'ok', bytes: TILE, contentType: 'application/x-protobuf' },
      { kind: 'status', status: 404, retryAfterMs: undefined },
    ];
    const transport: TileTransport = {
      start(_request, _timeouts, done: (result: TransportResult) => void) {
        done(answers.shift() ?? { kind: 'network-error' });
        return () => undefined;
      },
    };
    const loader = new VectorTileLoader({ transport, onReady: () => undefined });
    loader.setLayers(layers, 1);
    const [a, b] = [
      { z: 1, x: 0, y: 0 },
      { z: 1, x: 1, y: 0 },
    ];
    loader.update(
      [
        { url: 'a', tile: a, priority: 0 },
        { url: 'b', tile: b, priority: 1 },
      ],
      new Set(),
    );
    await tick();
    expect(loader.get(a)?.buckets[0]?.layerId).toBe('water');
    expect(loader.isMissing(b)).toBe(true);
  });

  it('requests a tile again after a while when its bytes do not lay out, as after a failed download (TG-04)', async () => {
    const corrupt = new Uint8Array([0x1a, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x08]).buffer;
    const table: Record<string, ArrayBuffer> = { c: corrupt };
    const transport = fakeTransport(table);
    let nowMs = 0;
    const loader = new VectorTileLoader({ transport, onReady: () => undefined, now: () => nowMs });
    loader.setLayers(layers, 1);
    const tile = { z: 1, x: 0, y: 0 };
    const wanted = [{ url: 'c', tile, priority: 0 }];
    loader.update(wanted, new Set());
    await tick();
    expect(loader.isMissing(tile)).toBe(false);
    table['c'] = TILE;
    nowMs = 6_000;
    loader.update(wanted, new Set());
    await tick();
    expect(loader.get(tile)?.buckets[0]?.layerId).toBe('water');
    expect(loader.requestLog).toEqual(['c', 'c']);
  });

  it('asks for a fresh copy, past the HTTP cache, when retrying bytes that did not lay out (TG-04)', async () => {
    // The browser may keep a corrupted body with the server's ETag; revalidating it gives the same bytes back.
    const corrupt = new Uint8Array([0x1a, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x08]).buffer;
    const reloads: (boolean | undefined)[] = [];
    const transport: TileTransport = {
      start(request: TileRequest, _timeouts, done: (result: TransportResult) => void) {
        reloads.push(request.reload);
        queueMicrotask(() => done({ kind: 'ok', bytes: corrupt.slice(0), contentType: 'application/x-protobuf' }));
        return () => undefined;
      },
    };
    let nowMs = 0;
    const loader = new VectorTileLoader({ transport, onReady: () => undefined, now: () => nowMs });
    loader.setLayers(layers, 1);
    const wanted = [{ url: 'c', tile: { z: 1, x: 0, y: 0 }, priority: 0 }];
    loader.update(wanted, new Set());
    await tick();
    nowMs = 6_000;
    loader.update(wanted, new Set());
    await tick();
    expect(reloads).toEqual([undefined, true]);
  });

  it('asks for a frame again while a wanted failed tile waits, even when a frame came a moment before its retry (TG-04)', async () => {
    vi.useFakeTimers();
    try {
      const transport: TileTransport = {
        start(_request, _timeouts, done: (result: TransportResult) => void) {
          queueMicrotask(() => done({ kind: 'network-error' }));
          return () => undefined;
        },
      };
      let nowMs = 0;
      let frames = 0;
      const loader = new VectorTileLoader({ transport, onReady: () => frames++, now: () => nowMs });
      const wanted = [{ url: 'f', tile: { z: 1, x: 0, y: 0 }, priority: 0 }];
      loader.update(wanted, new Set());
      await Promise.resolve();
      // The retry's frame comes a millisecond early by the loader's clock: the tile is not due yet.
      nowMs = 4_999;
      vi.advanceTimersByTime(5_000);
      expect(frames).toBe(1);
      loader.update(wanted, new Set());
      expect(loader.loading).toBe(1);
      // Another frame is asked for when it is due.
      vi.advanceTimersByTime(100);
      expect(frames).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not request again a tile its server refuses for good (401, 403, 410, CORS), only one that failed for now (500)', async () => {
    vi.useFakeTimers();
    try {
      const answers: Record<string, TransportResult> = {
        u: { kind: 'status', status: 401, retryAfterMs: undefined },
        f: { kind: 'status', status: 403, retryAfterMs: undefined },
        g: { kind: 'status', status: 410, retryAfterMs: undefined },
        c: { kind: 'network-error', cause: 'cors' },
        s: { kind: 'status', status: 500, retryAfterMs: undefined },
      };
      const requested: string[] = [];
      const transport: TileTransport = {
        start(request, _timeouts, done: (result: TransportResult) => void) {
          requested.push(request.url);
          queueMicrotask(() => done(answers[request.url] ?? { kind: 'network-error' }));
          return () => undefined;
        },
      };
      let nowMs = 0;
      const loader = new VectorTileLoader({ transport, onReady: () => undefined, now: () => nowMs });
      const wanted = Object.keys(answers).map((url, x) => ({ url, tile: { z: 3, x, y: 0 }, priority: x }));
      loader.update(wanted, new Set());
      await Promise.resolve();
      nowMs = 6_000;
      vi.advanceTimersByTime(6_000);
      loader.update(wanted, new Set());
      await Promise.resolve();
      expect(requested.sort()).toEqual(['c', 'f', 'g', 's', 's', 'u']);
      // Only the 500 keeps the loader busy: the refused tiles are missing, as a 404 is.
      expect(loader.loading).toBe(1);
      expect(wanted.filter((w) => loader.isMissing(w.tile)).map((w) => w.url)).toEqual(['u', 'f', 'g', 'c']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels tiles no frame wants any more', () => {
    const aborted: string[] = [];
    const transport: TileTransport = {
      start: (request) => () => aborted.push(request.url),
    };
    const loader = new VectorTileLoader({ transport, onReady: () => undefined });
    loader.update([{ url: 'x', tile: { z: 3, x: 1, y: 1 }, priority: 0 }], new Set());
    loader.update([], new Set());
    expect(aborted).toEqual(['x']);
  });
});
