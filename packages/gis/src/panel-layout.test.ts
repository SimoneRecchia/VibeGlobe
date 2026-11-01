// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { describe, expect, it } from 'vitest';
import type { LonLat } from './format.js';
import { layoutPanels } from './panel-layout.js';

/** The value, which the test expects to be there. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing value');
  return value;
}

const M = 111_320;
const LAT = 52.3;
const KX = M * Math.cos((LAT * Math.PI) / 180);
/** A position `east` and `north` meters from the test origin. */
const at = (east: number, north: number): LonLat => ({ longitudeDeg: 13 + east / KX, latitudeDeg: LAT + north / M });
const meters = (p: LonLat): [number, number] => [(p.longitudeDeg - 13) * KX, (p.latitudeDeg - LAT) * M];
const rectangle = (w: number, h: number, east = 0, north = 0): LonLat[] => [
  at(east, north),
  at(east + w, north),
  at(east + w, north + h),
  at(east, north + h),
];

/** Whether two panels of width `w` and depth `d` (east–west rows) overlap. */
function overlap(a: LonLat, b: LonLat, w: number, d: number): boolean {
  const [ax, ay] = meters(a);
  const [bx, by] = meters(b);
  return Math.abs(ax - bx) < w - 1e-6 && Math.abs(ay - by) < d - 1e-6;
}

describe('panel layout (F658)', () => {
  it('places panels in rows inside the perimeter, from the far row, without overlaps, at their size when room allows', () => {
    const layout = layoutPanels({ perimeters: [rectangle(100, 60)], count: 20, widthM: 10, depthM: 4 });
    expect(layout.scale).toBe(1);
    const placed = layout.centers.filter((c): c is LonLat => c !== undefined);
    expect(placed).toHaveLength(20);
    for (const c of placed) {
      const [x, y] = meters(c);
      expect(x).toBeGreaterThanOrEqual(5 - 1e-6);
      expect(x).toBeLessThanOrEqual(95 + 1e-6);
      expect(y).toBeGreaterThanOrEqual(2 - 1e-6);
      expect(y).toBeLessThanOrEqual(58 + 1e-6);
    }
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++) expect(overlap(must(placed[i]), must(placed[j]), 10, 4)).toBe(false);
    // The first panel stands in the northernmost row, the next one beside it.
    const [, firstY] = meters(must(placed[0]));
    expect(Math.max(...placed.map((c) => meters(c)[1]))).toBeCloseTo(firstY, 6);
    expect(meters(must(placed[1]))[0]).toBeGreaterThan(meters(must(placed[0]))[0]);
  });

  it('shrinks every panel alike when the perimeter cannot hold them, never below the smallest share', () => {
    const roomy = layoutPanels({ perimeters: [rectangle(52, 20)], count: 18, widthM: 10, depthM: 4, gapM: 0 });
    expect(roomy.scale).toBeLessThan(1);
    expect(roomy.scale).toBeGreaterThanOrEqual(0.85);
    expect(roomy.centers.every((c) => c !== undefined)).toBe(true);
    const crowded = layoutPanels({ perimeters: [rectangle(20, 10)], count: 50, widthM: 10, depthM: 4 });
    expect(crowded.scale).toBe(0.85);
    expect(crowded.centers.filter((c) => c === undefined).length).toBeGreaterThan(0);
  });

  it('goes around the panels that keep their places', () => {
    const fixed = [at(50, 30)];
    const layout = layoutPanels({ perimeters: [rectangle(100, 60)], count: 40, widthM: 10, depthM: 4, fixed });
    for (const c of layout.centers) if (c) expect(overlap(c, must(fixed[0]), 10.5, 8)).toBe(false);
  });

  it('puts a panel with a wanted position in the free place nearest to it', () => {
    const wanted = [undefined, at(88, 6)];
    const layout = layoutPanels({ perimeters: [rectangle(100, 60)], count: 2, widthM: 10, depthM: 4, wanted });
    const [x, y] = meters(must(layout.centers[1]));
    expect(Math.hypot(x - 88, y - 6)).toBeLessThan(8);
  });

  it('runs the rows along the bearing and fills several perimeters', () => {
    const north = layoutPanels({ perimeters: [rectangle(40, 100)], count: 6, widthM: 10, depthM: 4, rowBearingDeg: 0 });
    const xs = north.centers.map((c) => meters(must(c))[0]);
    expect(new Set(xs.slice(0, 3).map((x) => x.toFixed(3))).size).toBe(1);
    const two = layoutPanels({
      perimeters: [rectangle(30, 10), rectangle(30, 10, 200, 0)],
      count: 4,
      widthM: 10,
      depthM: 4,
    });
    expect(two.centers.some((c) => meters(must(c))[0] > 150)).toBe(true);
  });

  it('lines the rows up with an anchor, every place a whole number of steps from it (F677)', () => {
    const anchor = at(37.3, 41.7);
    const layout = layoutPanels({ perimeters: [rectangle(100, 60)], count: 12, widthM: 10, depthM: 4, anchor });
    const placed = layout.centers.filter((c): c is LonLat => c !== undefined);
    expect(placed).toHaveLength(12);
    for (const c of placed) {
      const [x, y] = meters(c);
      // Steps of 10.5 m along the rows (width and gap) and 8 m across them (depth and row gap), within a centimeter.
      expect(Math.abs((x - 37.3) / 10.5 - Math.round((x - 37.3) / 10.5))).toBeLessThan(1e-3);
      expect(Math.abs((y - 41.7) / 8 - Math.round((y - 41.7) / 8))).toBeLessThan(1e-3);
    }
  });
});

describe('panel layout at the size of a park (F658)', () => {
  it('lays out 3000 panels at their wanted places quickly enough for every drag', () => {
    const wanted = Array.from({ length: 3000 }, (_, i) => at((i % 60) * 15 + 7, Math.floor(i / 60) * 9 + 3));
    const started = performance.now();
    const layout = layoutPanels({ perimeters: [rectangle(920, 460)], count: 3000, widthM: 13.6, depthM: 4.6, wanted });
    const elapsed = performance.now() - started;
    expect(layout.centers.filter((c) => c !== undefined).length).toBe(3000);
    expect(elapsed).toBeLessThan(400);
  });
});

describe('panels moved by hand (F681) and panels without room (F682)', () => {
  const row = [rectangle(60, 4.5)];
  const sizes = { perimeters: row, widthM: 10, depthM: 4 };
  const xs = (centers: readonly (LonLat | undefined)[]) => centers.map((c) => meters(must(c))[0]);

  it('shifts the panels in the way along the row toward the nearest free place, in order', () => {
    const start = layoutPanels({ ...sizes, count: 4 }).centers.map(must);
    const before = xs(start);
    const wanted = [...start.slice(0, 3), must(start[0])];
    const moved = layoutPanels({ ...sizes, count: 4, wanted, moving: [3], anchor: must(start[0]) });
    const after = xs(moved.centers);
    expect(after[3]).toBeCloseTo(must(before[0]), 3);
    for (const panel of [0, 1, 2]) expect(after[panel]).toBeCloseTo(must(before[panel + 1]), 3);
  });

  it('keeps every panel placed, none overlapping, when one is dragged across a full row', () => {
    const start = layoutPanels({ ...sizes, count: 5 }).centers.map(must);
    const wanted = [...start.slice(0, 4), at(8, 2)];
    const moved = layoutPanels({ ...sizes, count: 5, wanted, moving: [4], anchor: must(start[0]) });
    const placed = moved.centers.map(must);
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++) expect(overlap(must(placed[i]), must(placed[j]), 10, 4)).toBe(false);
    expect(xs(placed)[4]).toBeCloseTo(Math.min(...xs(placed)), 3);
  });

  it('lines up the panels without room beyond the last row, outside the perimeter and apart', () => {
    const layout = layoutPanels({ ...sizes, count: 8, minScale: 1, spill: true });
    const placed = layout.centers.map(must);
    expect(placed.filter((c) => meters(c)[1] < 0)).toHaveLength(3);
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++) expect(overlap(must(placed[i]), must(placed[j]), 10, 4)).toBe(false);
  });
});
