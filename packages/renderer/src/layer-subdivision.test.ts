import { describe, expect, it } from 'vitest';
import { greatCirclePoints, MAX_STEP_DEG, subdivide, type Triangle, type Vertex } from './layer-subdivision.js';

const DEG = Math.PI / 180;
const arcDeg = (u: Vertex, v: Vertex): number =>
  Math.acos(
    Math.min(
      1,
      Math.sin(u[1] * DEG) * Math.sin(v[1] * DEG) +
        Math.cos(u[1] * DEG) * Math.cos(v[1] * DEG) * Math.cos((v[0] - u[0]) * DEG),
    ),
  ) / DEG;

describe('layer subdivision', () => {
  it('splits by ground distance, not longitude degrees, near the poles (KB-103)', () => {
    // A sliver of a 300 km circle at 87° N spans 130° of longitude but only about 5.4° of arc.
    const triangle: Triangle = [
      [-65, 87, 0],
      [65, 87, 0],
      [0, 89.7, 0],
    ];
    expect(subdivide(triangle, MAX_STEP_DEG).length).toBeLessThanOrEqual(64);
    expect(greatCirclePoints([-65, 87, 0], [65, 87, 0], MAX_STEP_DEG).length).toBeLessThanOrEqual(10);
  });

  it('splits the thin triangles of a ring into about as many pieces as their area needs (KB-103)', () => {
    // A 4.5° disc at 60° N triangulated as a fan from one ring vertex, split to the drape step of 0.09°.
    const ring: Vertex[] = [];
    for (let i = 0; i < 96; i++) {
      const a = (2 * Math.PI * i) / 96;
      ring.push([10 + (4.5 * Math.cos(a)) / Math.cos(60 * DEG), 60 + 4.5 * Math.sin(a), 0]);
    }
    const first = ring[0] ?? [0, 0, 0];
    let pieces = 0;
    for (let i = 1; i + 1 < ring.length; i++) {
      for (const piece of subdivide([first, ring[i] ?? first, ring[i + 1] ?? first], 0.09)) {
        pieces++;
        for (let k = 0; k < 3; k++)
          expect(arcDeg(piece[k] ?? first, piece[(k + 1) % 3] ?? first)).toBeLessThanOrEqual(0.09 + 1e-9);
      }
    }
    // The disc's area over a piece's (a right triangle of 0.09° legs) is about 15,700; splitting every sliver in four
    // until its long edges were short made about ten times as many as halving the longest edge, under 130,000.
    expect(pieces).toBeLessThan(130_000);
  });

  it('still splits long edges on the equator into pieces of at most the step', () => {
    for (const piece of subdivide(
      [
        [0, 0, 0],
        [4, 0, 0],
        [0, 4, 0],
      ],
      MAX_STEP_DEG,
    ))
      for (let k = 0; k < 3; k++)
        expect(arcDeg(piece[k] ?? [0, 0, 0], piece[(k + 1) % 3] ?? [0, 0, 0])).toBeLessThanOrEqual(MAX_STEP_DEG + 1e-9);
    expect(greatCirclePoints([0, 0, 0], [10, 0, 0], MAX_STEP_DEG)).toHaveLength(11);
  });
});
