import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EUROPE_LAND } from './europe-land.js';
import { decodePolygons, encodePolygons } from './polygons.js';

describe('the bundled polygons (KB-297)', () => {
  it('store the land mask in under a third of its JSON, and read every point back exactly', () => {
    const source = readFileSync(new URL('./europe-land.ts', import.meta.url), 'utf8');
    expect(source.length).toBeLessThan(JSON.stringify(EUROPE_LAND).length / 3);
    const polygons: [number, number][][][] = [
      [
        [
          [-2.019, 49.231],
          [-2.01, 49.181],
          [-179.999, -85.001],
          [-2.019, 49.231],
        ],
        [
          [0, 0],
          [45.5, -0.001],
          [0.999, 72],
        ],
      ],
      [
        [
          [10, 10],
          [10.001, 10],
          [10, 10.001],
        ],
      ],
    ];
    expect(decodePolygons(encodePolygons(polygons))).toEqual(polygons);
    expect(decodePolygons(encodePolygons(EUROPE_LAND))).toEqual(EUROPE_LAND);
  });
});
