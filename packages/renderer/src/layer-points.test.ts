import type { BatchAttribute } from '@vibeglobe/core';
import { describe, expect, it } from 'vitest';
import { FeatureChanges } from './layer-changes.hot.js';
import type { BatchContents } from './layer-contents.js';
import { buildLayerArrays } from './layer-geometry.js';
import { writePointQuad } from './layer-points.hot.js';

/** A point batch of `count` features with varied positions, colors, sizes, anchors, offsets, rotations and visibility. */
function points(count: number): BatchContents {
  const attributes = new Map<BatchAttribute, Float64Array>();
  const each = (name: BatchAttribute, components: number, value: (f: number, c: number) => number): void => {
    const values = new Float64Array(count * components);
    for (let f = 0; f < count; f++) for (let c = 0; c < components; c++) values[f * components + c] = value(f, c);
    attributes.set(name, values);
  };
  each('position', 3, (f, c) => [10 + f * 0.7, 40 + f * 0.3, f * 5][c] ?? 0);
  each('color', 4, (f, c) => ((f + c) % 5) / 4);
  each('sizePx', 1, (f) => 2 + f);
  each('anchor', 1, (f) => f % 9);
  each('offsetPx', 2, (f, c) => (c === 0 ? f : -f / 2));
  each('rotationDeg', 1, (f) => f * 13);
  each('opacity', 1, (f) => 1 - f / 40);
  each('visible', 1, (f) => (f % 7 === 3 ? 0 : 1));
  return { kind: 'point', count, attributes, uniforms: new Map(), strings: new Map(), geometry: new Map() };
}

describe('point quads rewritten in place (F378)', () => {
  it('writes the same vertices as a full build, hidden points collapsed', () => {
    const batch = points(20);
    const built = buildLayerArrays(batch);
    const rewritten = buildLayerArrays(batch);
    if (!built || !rewritten) throw new Error('no arrays');
    for (const array of [rewritten.positions, rewritten.heights, rewritten.colors, rewritten.corners, rewritten.uvs])
      array.fill(9);
    for (let f = 0; f < batch.count; f++) writePointQuad(batch, rewritten, f, undefined);
    for (const name of ['positions', 'normals', 'planes', 'heights', 'colors', 'corners', 'uvs'] as const)
      expect([...rewritten[name]], name).toEqual([...built[name]]);
  });

  it('drains marked features as runs of consecutive features, in order, once each', () => {
    const changes = new FeatureChanges();
    changes.mark(5000, 5001);
    changes.mark(7, 9);
    changes.mark(9, 10);
    changes.mark(3, 4);
    changes.mark(8, 9);
    const runs: [number, number][] = [];
    expect(changes.drain((first, end) => (runs.push([first, end]), true))).toBe(true);
    expect(runs).toEqual([
      [3, 4],
      [7, 10],
      [5000, 5001],
    ]);
    expect(changes.empty).toBe(true);
    // A refused run reports false and still clears every mark.
    changes.mark(1, 2);
    changes.mark(4, 5);
    expect(changes.drain(() => false)).toBe(false);
    expect(changes.drain(() => true) && changes.empty).toBe(true);
  });
});
