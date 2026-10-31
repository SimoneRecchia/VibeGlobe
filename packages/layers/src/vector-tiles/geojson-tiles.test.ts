import { decodeMvt } from '@vibeglobe/sources/vector';
import { describe, expect, it } from 'vitest';
import { encodeGeoJsonTile, geojsonShapes, geojsonTransport } from './geojson-tiles.js';
import { layoutVectorTile } from './layout-tile.js';
import { resolveSource, tileUrl, transformedTransport } from './style-sources.js';

const DATA = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: 7,
      properties: { name: 'square', rank: 2 },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-10, -10],
            [10, -10],
            [10, 10],
            [-10, 10],
            [-10, -10],
          ],
        ],
      },
    },
    { type: 'Feature', properties: { kind: 'dot' }, geometry: { type: 'Point', coordinates: [5, 5] } },
  ],
};

describe('GeoJSON sources (F444)', () => {
  it('cuts the data into vector tiles that lay out like downloaded ones', () => {
    const bytes = encodeGeoJsonTile(geojsonShapes(DATA), 1, 1, 0);
    const layer = bytes === undefined ? undefined : decodeMvt(bytes)?.layers[0];
    expect(layer?.name).toBe('_geojsonTileLayer');
    expect(layer?.features.map((f) => [f.type, f.id, f.properties])).toEqual([
      ['Polygon', 7, { name: 'square', rank: 2 }],
      ['Point', undefined, { kind: 'dot' }],
    ]);
    // A style layer on a GeoJSON source has no source-layer.
    const buckets = layoutVectorTile({
      bytes: bytes ?? new ArrayBuffer(0),
      layers: [{ id: 'fill', type: 'fill', source: 'g', paint: { 'fill-color': '#f00' } }],
      zoom: 1,
    });
    expect(buckets[0]?.geometry?.indices.length).toBeGreaterThan(0);
    // The south-western tile at zoom 3 is far from the data.
    expect(encodeGeoJsonTile(geojsonShapes(DATA), 3, 0, 7)).toBeUndefined();
  });

  it('answers tile requests and never throws on malformed data', async () => {
    const results: string[] = [];
    const transport = geojsonTransport(DATA);
    transport.start({ url: 'geojson://g/1/1/0', hostIndex: 0 }, { firstByteMs: 1, totalMs: 1 }, (r) =>
      results.push(r.kind),
    );
    transport.start({ url: 'geojson://g/3/0/7', hostIndex: 0 }, { firstByteMs: 1, totalMs: 1 }, (r) =>
      results.push(r.kind),
    );
    expect(results).toEqual([]);
    await Promise.resolve();
    expect(results).toEqual(['ok', 'status']);
    for (const bad of [null, 3, { type: 'Feature', geometry: { type: 'Polygon', coordinates: 5 } }, { type: 'X' }])
      expect(() => encodeGeoJsonTile(geojsonShapes(bad), 0, 0, 0)).not.toThrow();
  });

  it('resolves GeoJSON sources to local tiles and rewrites the URLs of others', async () => {
    const info = await resolveSource({ type: 'geojson', data: DATA } as never, undefined, fetch, 'crimea');
    expect(info === undefined ? '' : tileUrl(info, { z: 1, x: 1, y: 0 })).toBe('geojson://crimea/1/1/0');
    expect(info?.geojson).toBe(DATA);
    const seen: string[] = [];
    const transport = transformedTransport({ start: (request) => (seen.push(request.url), () => undefined) }, (url) =>
      url.replace('https://demotiles.maplibre.org/', '/fixtures/'),
    );
    transport.start(
      { url: 'https://demotiles.maplibre.org/tiles/0/0/0.pbf', hostIndex: 0 },
      { firstByteMs: 1, totalMs: 1 },
      () => undefined,
    );
    expect(seen).toEqual(['/fixtures/tiles/0/0/0.pbf']);
  });

  it('applies text-transform and legacy tokens to labels', () => {
    const bytes = encodeGeoJsonTile(geojsonShapes(DATA), 1, 1, 0) ?? new ArrayBuffer(0);
    const [bucket] = layoutVectorTile({
      bytes,
      layers: [
        {
          id: 'l',
          type: 'symbol',
          source: 'g',
          layout: { 'text-field': ['get', 'kind'], 'text-transform': 'uppercase' },
        },
      ],
      zoom: 1,
    });
    expect(bucket?.labels?.map((l) => l.text)).toEqual(['DOT']);
    // A legacy token string reads the feature's properties.
    const [tokens] = layoutVectorTile({
      bytes,
      layers: [{ id: 'l', type: 'symbol', source: 'g', layout: { 'text-field': '{kind}!' } }],
      zoom: 1,
    });
    expect(tokens?.labels?.map((l) => l.text)).toEqual(['dot!']);
  });
});

describe('GeoJSON tiling cost', () => {
  it('tiles a long line with line metrics and many named features in time proportional to their size', () => {
    // A 20,000-vertex track and 5,000 points each with its own name: quadratic steps took seconds here.
    const track = Array.from({ length: 20_000 }, (_, i) => [-170 + (i / 20_000) * 340, Math.sin(i / 50) * 10]);
    const points = Array.from({ length: 5000 }, (_, i) => ({
      type: 'Feature',
      properties: { name: `P${String(i)}` },
      geometry: { type: 'Point', coordinates: [-170 + (i / 5000) * 340, 5] },
    }));
    const data = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: track } }, ...points],
    };
    const shapes = geojsonShapes(data);
    const startMs = performance.now();
    expect(encodeGeoJsonTile(shapes, 0, 0, 0, true)).toBeDefined();
    expect(performance.now() - startMs).toBeLessThan(1000);
  });
});
