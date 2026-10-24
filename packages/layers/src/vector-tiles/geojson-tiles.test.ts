import { decodeMvt } from '@vibeglobe/sources/vector';
import { describe, expect, it } from 'vitest';
import { encodeGeoJsonTile, geojsonShapes, geojsonTransport } from './geojson-tiles.js';
import { layoutVectorTile } from './layout-tile.js';

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

  it('answers tile requests and never throws on malformed data', () => {
    const results: string[] = [];
    const transport = geojsonTransport(DATA);
    transport.start({ url: 'geojson://g/1/1/0', hostIndex: 0 }, { firstByteMs: 1, totalMs: 1 }, (r) =>
      results.push(r.kind),
    );
    transport.start({ url: 'geojson://g/3/0/7', hostIndex: 0 }, { firstByteMs: 1, totalMs: 1 }, (r) =>
      results.push(r.kind),
    );
    expect(results).toEqual(['ok', 'status']);
    for (const bad of [null, 3, { type: 'Feature', geometry: { type: 'Polygon', coordinates: 5 } }, { type: 'X' }])
      expect(() => encodeGeoJsonTile(geojsonShapes(bad), 0, 0, 0)).not.toThrow();
  });
});
