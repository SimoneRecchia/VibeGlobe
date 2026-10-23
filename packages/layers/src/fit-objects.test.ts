import type { Globe } from '@vibeglobe/core';
import { describe, expect, it } from 'vitest';
import { extentOf, fitObjects } from './fit-objects.js';

describe('fitting to objects (F387)', () => {
  it('collects every vertex at its altitude or extrusion top, and fits the vertices around the bounds middle', () => {
    const objects = [
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [10, 40, 500] } },
      {
        type: 'Feature',
        properties: { height: 120 },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [11, 41],
              [12, 41],
              [12, 42],
              [11, 41],
            ],
          ],
        },
      },
      { longitudeDeg: 9, latitudeDeg: 43, heightMeters: 30 },
    ] as const;
    const extent = extentOf(objects);
    expect(extent?.bounds).toEqual({ westDeg: 9, southDeg: 40, eastDeg: 12, northDeg: 43 });
    expect(extent?.vertices.map((v) => v.heightMeters)).toEqual([500, 120, 120, 120, 120, 30]);
    const calls: unknown[][] = [];
    const globe = { fitBounds: (...args: unknown[]) => calls.push(args) } as unknown as Pick<Globe, 'fitBounds'>;
    fitObjects(globe, objects, { paddingPx: 20 });
    const [bounds, options] = calls[0] as [
      { westDeg: number; eastDeg: number },
      { include: unknown[]; paddingPx: number },
    ];
    expect([bounds.westDeg, bounds.eastDeg]).toEqual([10.5, 10.5]);
    expect([options.paddingPx, options.include.length]).toEqual([20, 6]);
    expect(() => fitObjects(globe, [])).toThrow(RangeError);
  });
});
