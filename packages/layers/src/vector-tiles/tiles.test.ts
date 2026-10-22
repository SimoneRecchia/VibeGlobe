import { describe, expect, it } from 'vitest';
import { encodeMvt } from '../__fixtures__/mvt-writer.js';
import { fillArea } from './fill-tessellate.js';
import { layoutVectorTile, VECTOR_TILE_TASKS, type Bucket } from './layout-tile.js';
import { StyleLayer } from './style-layer.js';
import { inCoverage, overzoom, tileKey, tilesToDraw, tilesToRequest, type TileId } from './tile-pyramid.js';

const square = (x0: number, y0: number, x1: number, y1: number) => [
  [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
  ] as [number, number][],
];

const TILE = encodeMvt({
  water: [{ id: 1, type: 'Polygon', geometry: square(0, 0, 2048, 2048), properties: { class: 'lake' } }],
  transportation: [
    {
      id: 2,
      type: 'LineString',
      geometry: [
        [
          [0, 100],
          [4096, 100],
        ],
      ],
      properties: { class: 'primary', name: 'Via Roma' },
    },
    {
      id: 3,
      type: 'LineString',
      geometry: [
        [
          [0, 300],
          [4096, 300],
        ],
      ],
      properties: { class: 'path' },
    },
  ],
  building: [
    { id: 4, type: 'Polygon', geometry: square(100, 100, 200, 200), properties: { height: 30 } },
    { id: 5, type: 'Polygon', geometry: square(300, 300, 400, 400), properties: { building: 'garage' } },
  ],
  place: [{ id: 6, type: 'Point', geometry: [[[1000, 1000]]], properties: { name: 'Milano', class: 'city' } }],
});

const LAYERS = [
  { id: 'water', type: 'fill', source: 'osm', 'source-layer': 'water' },
  {
    id: 'roads',
    type: 'line',
    source: 'osm',
    'source-layer': 'transportation',
    filter: ['==', ['get', 'class'], 'primary'],
    layout: { 'line-cap': 'butt' },
  },
  { id: 'buildings', type: 'fill-extrusion', source: 'osm', 'source-layer': 'building' },
  {
    id: 'road-names',
    type: 'symbol',
    source: 'osm',
    'source-layer': 'transportation',
    layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'] },
  },
  { id: 'places', type: 'symbol', source: 'osm', 'source-layer': 'place', layout: { 'text-field': ['get', 'name'] } },
];

const byId = (buckets: Bucket[], id: string) => buckets.find((b) => b.layerId === id);

describe('vector tile layout in workers (F443)', () => {
  it('builds one bucket per style layer with filtered features and their geometry', () => {
    const buckets = layoutVectorTile({ bytes: TILE, layers: LAYERS, zoom: 14 });
    expect(buckets.map((b) => b.layerId)).toEqual(['water', 'roads', 'buildings', 'road-names', 'places']);
    const water = byId(buckets, 'water');
    expect(
      fillArea({
        positions: water?.geometry?.positions ?? new Float32Array(),
        indices: water?.geometry?.indices ?? new Uint32Array(),
      }),
    ).toBe(2048 * 2048);
    expect(byId(buckets, 'roads')?.features.map((f) => f.id)).toEqual([2]);
    const roads = byId(buckets, 'roads')?.geometry;
    expect(roads?.extrusions?.length).toBe(roads?.positions.length);
    const heights = new Set(
      Array.from(byId(buckets, 'buildings')?.geometry?.positions ?? []).filter((_, i) => i % 3 === 2),
    );
    expect([...heights].sort((a, b) => a - b)).toEqual([0, 3, 30]);
    expect(byId(buckets, 'road-names')?.labels?.map((l) => l.text)).toEqual(['Via Roma']);
    expect(byId(buckets, 'road-names')?.glyphRanges).toEqual({ 'Noto Sans Regular': [0] });
    expect(byId(buckets, 'places')?.labels?.[0]?.anchor).toEqual([1000, 1000]);
  });

  it('keeps features and per-vertex indices so paint changes need no new layout (F450)', () => {
    const buckets = layoutVectorTile({ bytes: TILE, layers: LAYERS, zoom: 14 });
    const roads = byId(buckets, 'roads');
    expect(new Set(roads?.geometry?.featureIndex)).toEqual(new Set([0]));
    const layer = new StyleLayer({
      ...LAYERS[1],
      paint: { 'line-color': ['match', ['get', 'class'], 'primary', 'red', 'blue'] },
    } as never);
    expect(roads?.features.map((f) => layer.paint('line-color', 14, f))).toEqual([{ r: 1, g: 0, b: 0, a: 1 }]);
  });

  it('runs as a pool task with transferred buffers and a worker performance mark', () => {
    const task = VECTOR_TILE_TASKS['layout-vector-tile'];
    const result = task?.({ bytes: TILE, layers: LAYERS, zoom: 14 }, {
      signal: new AbortController().signal,
    } as never) as {
      output: Bucket[];
      transfer: ArrayBuffer[];
    };
    expect(result.output).toHaveLength(5);
    expect(result.transfer.length).toBeGreaterThan(5);
    expect(performance.getEntriesByName('vibeglobe:layout-vector-tile').length).toBeGreaterThan(0);
    expect(() => task?.({ layers: [] }, {} as never)).toThrow(/needs bytes/);
    expect(layoutVectorTile({ bytes: new Uint8Array([9, 9, 9]).buffer, layers: LAYERS, zoom: 1 })).toEqual([]);
  });

  it('overzooms the deepest tile: the target reads a scaled sub-square', () => {
    const transform = overzoom({ z: 16, x: 4 * 100 + 1, y: 4 * 200 + 2 }, { minzoom: 0, maxzoom: 14 });
    expect(transform).toEqual({ source: { z: 14, x: 100, y: 200 }, scale: 4, offsetX: 0.25, offsetY: 0.5 });
    const buckets = layoutVectorTile({
      bytes: TILE,
      layers: LAYERS.slice(0, 1),
      zoom: 15,
      overzoom: overzoom({ z: 15, x: 0, y: 0 }, { minzoom: 0, maxzoom: 14 }),
    });
    const water = byId(buckets, 'water')?.geometry;
    // The lake covers the source tile's top-left quarter, which is the whole of the child tile.
    expect(
      fillArea({ positions: water?.positions ?? new Float32Array(), indices: water?.indices ?? new Uint32Array() }),
    ).toBe(4096 ** 2);
  });
});

describe('overzoom, coverage and parent fallback (F442)', () => {
  const coverage = { minzoom: 0, maxzoom: 14, bounds: [6, 36, 19, 47.5] as const };
  const children = (t: TileId): TileId[] =>
    [0, 1, 2, 3].map((i) => ({ z: t.z + 1, x: 2 * t.x + (i % 2), y: 2 * t.y + (i >> 1) }));

  it('requests no tile above maxzoom and none outside the bounds', () => {
    const z19 = Array.from({ length: 4 }, (_, i) => ({ z: 19, x: 275000 + i, y: 187000 }));
    const requests = tilesToRequest(z19, coverage);
    expect(requests.every((t) => t.z === 14)).toBe(true);
    expect(requests.map(tileKey)).toEqual(['14/8593/5843']);
    expect(inCoverage({ z: 5, x: 17, y: 11 }, coverage)).toBe(true);
    expect(inCoverage({ z: 5, x: 0, y: 0 }, coverage)).toBe(false);
    expect(tilesToRequest([{ z: 5, x: 0, y: 0 }], coverage)).toEqual([]);
  });

  it('draws the nearest ready ancestor in place of a missing tile, clipped to each target once', () => {
    const parent = { z: 10, x: 545, y: 368 };
    const visible = children(parent);
    const ready = new Set([tileKey(parent), tileKey(visible[0] as TileId)]);
    const draws = tilesToDraw(visible, coverage, (t) => ready.has(tileKey(t)));
    expect(draws.map((d) => [tileKey(d.tile), tileKey(d.target), d.standIn])).toEqual([
      ['11/1090/736', '11/1090/736', false],
      ['10/545/368', '11/1091/736', true],
      ['10/545/368', '11/1090/737', true],
      ['10/545/368', '11/1091/737', true],
    ]);
    expect(new Set(draws.map((d) => tileKey(d.target))).size).toBe(visible.length);
  });

  it('never leaves a covered target empty while any ancestor is ready', () => {
    const visible = children({ z: 12, x: 2180, y: 1472 });
    const draws = tilesToDraw(visible, coverage, (t) => t.z <= 3);
    expect(draws).toHaveLength(4);
    expect(draws.every((d) => d.tile.z === 3 && d.standIn)).toBe(true);
  });
});
