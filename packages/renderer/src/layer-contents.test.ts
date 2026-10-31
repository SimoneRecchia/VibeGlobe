// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { describe, expect, it } from 'vitest';
import { rises, type BatchContents } from './layer-contents.js';

const polygons = (heights: number[], uniform?: number): BatchContents => ({
  kind: 'polygon',
  count: heights.length,
  attributes: new Map([['heightMeters', Float64Array.from(heights)]]),
  uniforms: new Map(uniform === undefined ? [] : [['heightMeters', Float64Array.of(uniform)]]),
  strings: new Map(),
  geometry: new Map(),
});

describe('polygon batches that rise (KB-285)', () => {
  it('rises only where a height is not 0: a layer writes every channel, so the attribute alone says nothing', () => {
    expect(rises(polygons([0, 0, 0]))).toBe(false);
    expect(rises(polygons([0, 12, 0]))).toBe(true);
    expect(rises(polygons([0, 0], 3))).toBe(true);
  });
});
