import { geodeticToEcef, type TileRequest, type TileTransport, type TransportResult } from '@vibeglobe/core';
import { describe, expect, it } from 'vitest';
import { encodeMvt } from '../__fixtures__/mvt-writer.js';
import { fillArea, tessellateFill, tileClipRect } from './fill-tessellate.js';
import { globeVertices, maxEdgeUnits, subdividedFill, tileOrigin, tileToLonLat } from './globe-vertices.js';
import { BUCKET_BUFFER, BUCKET_EXTENT, layoutVectorTile } from './layout-tile.js';
import { StyleLayer } from './style-layer.js';
import { VectorTileLoader } from './tile-loader.js';
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
    const tiles = sampledTiles(sampler, 640, 480);
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
