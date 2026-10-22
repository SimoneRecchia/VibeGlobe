import { describe, expect, it } from 'vitest';
import { syntheticOsmExtract } from '../fixtures/osm-sample.js';
import { writeOsmPbf } from '../fixtures/synthetic.js';
import { parseMeters, placeFeature, wayFeature } from './features.js';
import { decodeTile, encodeTile } from './mvt.js';
import { memorySource, scanPbf } from './osm-pbf.js';
import { clipLine, clipRing, featureInTile } from './tiler.js';

describe('vector tiles', () => {
  it('reads nodes, tags and ways from a PBF extract', () => {
    const pbf = writeOsmPbf(
      [
        { id: 1, lon: 6.9, lat: 45.9, tags: { place: 'town', name: 'A' } },
        { id: 5, lon: -0.5, lat: -10.25, tags: {} },
      ],
      [{ id: 9, tags: { highway: 'primary' }, refs: [1, 5] }],
    );
    const nodes: unknown[] = [];
    const ways: unknown[] = [];
    scanPbf(memorySource(pbf), { node: (n) => nodes.push(n), way: (w) => ways.push(w) });
    expect(nodes).toEqual([
      { id: 1, lon: expect.closeTo(6.9, 7), lat: expect.closeTo(45.9, 7), tags: { place: 'town', name: 'A' } },
      { id: 5, lon: expect.closeTo(-0.5, 7), lat: expect.closeTo(-10.25, 7), tags: {} },
    ]);
    expect(ways).toEqual([{ id: 9, tags: { highway: 'primary' }, refs: [1, 5] }]);
  });

  it('keeps building heights and levels and parses OSM lengths', () => {
    expect([parseMeters('12'), parseMeters('12.5 m'), parseMeters("40'"), parseMeters('tall')]).toEqual([
      12,
      12.5,
      12.19,
      undefined,
    ]);
    const ring: [number, number][] = [
      [0, 0],
      [0.001, 0],
      [0.001, 0.001],
      [0, 0],
    ];
    const way = {
      id: 1,
      refs: [1, 2, 3, 1],
      tags: { building: 'yes', height: '21 m', 'building:levels': '7', min_height: '3' },
    };
    expect(wayFeature(way, ring)?.properties).toEqual({ building: 'yes', height: 21, min_height: 3, levels: 7 });
    expect(
      placeFeature({ id: 2, lon: 1, lat: 2, tags: { place: 'city', name: 'Roma', population: '2750000' } }),
    ).toMatchObject({
      layer: 'places',
      minZoom: 4,
      properties: { class: 'city', name: 'Roma', population: 2750000 },
    });
  });

  it('clips lines and rings to the buffered tile', () => {
    expect(
      clipLine(
        [
          [-10, 5],
          [10, 5],
        ],
        0,
        8,
      ),
    ).toEqual([
      [
        [0, 5],
        [8, 5],
      ],
    ]);
    expect(
      clipLine(
        [
          [1, 1],
          [20, 1],
          [20, 2],
          [1, 2],
        ],
        0,
        8,
      ),
    ).toEqual([
      [
        [1, 1],
        [8, 1],
      ],
      [
        [8, 2],
        [1, 2],
      ],
    ]);
    const clipped = clipRing(
      [
        [-5, -5],
        [5, -5],
        [5, 5],
        [-5, 5],
        [-5, -5],
      ],
      0,
      10,
    );
    expect(clipped).toHaveLength(5);
    expect(clipped.every(([x, y]) => x >= 0 && y >= 0)).toBe(true);
  });

  it('encodes MVT that decodes back with clockwise exterior rings and typed values', () => {
    const square = {
      id: 7,
      layer: 'buildings' as const,
      type: 'polygon' as const,
      minZoom: 0,
      properties: { height: 12.5, levels: 3, building: 'yes' },
      coordinates: [
        [1, 1],
        [1, 2],
        [2, 2],
        [2, 1],
        [1, 1],
      ] as [number, number][],
    };
    const feature = featureInTile(square, 0, 0, 0);
    expect(feature).toBeDefined();
    const decoded = decodeTile(encodeTile([['buildings', feature ? [feature] : []]]));
    const [ring] = decoded['buildings']?.features[0]?.parts ?? [];
    let area = 0;
    for (let i = 0; ring && i + 1 < ring.length; i++)
      area += (ring[i]?.[0] ?? 0) * (ring[i + 1]?.[1] ?? 0) - (ring[i + 1]?.[0] ?? 0) * (ring[i]?.[1] ?? 0);
    expect(area).toBeGreaterThan(0);
    expect(decoded['buildings']?.features[0]?.properties).toEqual({ building: 'yes', height: 12.5, levels: 3 });
    expect(decoded['buildings']?.extent).toBe(4096);
  });

  it('reads the synthetic sample extract', () => {
    let buildings = 0;
    scanPbf(memorySource(syntheticOsmExtract()), { way: (w) => (buildings += w.tags['building'] ? 1 : 0) });
    expect(buildings).toBe(32);
  });
});
