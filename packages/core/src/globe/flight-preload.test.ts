// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { describe, expect, it } from 'vitest';
import { Camera } from '../camera/camera.js';
import { FlightPlan, type MovementPath } from './flight-preload.js';

const DEG = Math.PI / 180;

/** An 800 × 600 camera, still, over its start. */
function camera(): Camera {
  const current = new Camera();
  current.widthPx = 800;
  current.heightPx = 600;
  current.update();
  return current;
}

/** The selection rules. */
const selection = () => ({ maxScreenErrorPx: 1, maxLevel: 22, imageryTexelsPerTile: 256, imageryMaxLevel: 19 });

/** A straight movement at a range from `fromDeg` to `toDeg` (longitude, latitude) in `durationMs`, from time 0. */
function straight(fromDeg: [number, number], toDeg: [number, number], rangeMeters: number, durationMs: number) {
  const path: MovementPath = {
    durationMs,
    step(cam, io) {
      const f = Math.min(1, Math.max(0, (io[0] ?? 0) / durationMs));
      cam.pose.targetLongitudeRad = (fromDeg[0] + (toDeg[0] - fromDeg[0]) * f) * DEG;
      cam.pose.targetLatitudeRad = (fromDeg[1] + (toDeg[1] - fromDeg[1]) * f) * DEG;
      cam.pose.rangeMeters = rangeMeters;
      return f >= 1;
    },
  };
  return { path, end: Float64Array.of(toDeg[0] * DEG, toDeg[1] * DEG, rangeMeters, 0, 0) };
}

describe('FlightPlan', () => {
  it('selects the destination no finer than the detail it is given allows (F287)', () => {
    // The destination of a descent onto Tokyo, 20 km above it.
    const end = Float64Array.of(139.7 * DEG, 35.7 * DEG, 20_000, 0, 0);
    const deepest = (texelErrorPx: number): number => {
      const plan = new FlightPlan();
      plan.plan(camera(), end, selection(), texelErrorPx, 0);
      return Math.max(...plan.tiles.slice(0, plan.arrival).map((tile) => tile.level));
    };
    // Still: texels up to 1.5 px; at full speed the motion factor allows four times that. Tiles near the eye still
    // refine for their size against the distance, which motion does not change, so the deepest level drops by one here.
    const still = deepest(1.5);
    const fast = deepest(1.5 * 4);
    expect(still).toBeGreaterThan(8);
    expect(fast).toBeLessThan(still);
    for (const factor of [1, 2, 4]) expect(deepest(1.5 * factor)).toBeLessThanOrEqual(still);
  });

  it('plans the destination, the path at the times it is first shown and a coarse ring, each tile once (F671)', () => {
    const { path, end } = straight([11, 45], [12.5, 42], 50_000, 4000);
    const plan = new FlightPlan();
    plan.plan(camera(), end, selection(), 1.5, 0, path);
    const destination = new FlightPlan();
    destination.plan(camera(), end, selection(), 1.5, 0);
    const keys = plan.tiles.slice(0, plan.count).map((tile) => tile.key);
    expect(new Set(keys).size).toBe(plan.count);
    // The destination's view first, as it is alone; then the path and the margin ring.
    expect(keys.slice(0, plan.arrival)).toEqual(destination.tiles.slice(0, destination.arrival).map((t) => t.key));
    expect(destination.count).toBeGreaterThan(destination.arrival);
    expect(plan.count).toBeGreaterThan(destination.count);
    const at = (ms: number): number[] => {
      plan.keysAt(Float64Array.of(ms));
      return [...plan.keys.subarray(0, plan.count)];
    };
    // At the start: the destination as if needed within a second, the path's first two seconds in time order, the rest
    // of the path and the ring not yet.
    const start = at(0);
    for (const key of start.slice(0, plan.arrival)) expect(key).toBe(1000 / 8);
    expect(start.at(-1)).toBe(-1);
    const wanted = start.slice(plan.arrival).filter((key) => key >= 0);
    expect(wanted.length).toBeGreaterThan(0);
    expect(wanted).toEqual([...wanted].sort((a, b) => a - b));
    // Near the end: the path's early tiles are past and no longer wanted; the destination and its ring are needed now.
    const late = at(3900);
    expect(late.slice(plan.arrival, plan.arrival + 5)).toEqual([-1, -1, -1, -1, -1]);
    for (const key of late.slice(0, plan.arrival)) expect(key).toBeCloseTo(100 / 8, 9);
    expect(late.at(-1)).toBeCloseTo(100 / 8, 9);
    plan.clear();
    expect(plan.count).toBe(0);
  });

  it('asks for path tiles at the detail a moving camera shows, one level coarser on a slow link (F287, F301)', () => {
    const { path, end } = straight([2, 45], [14, 45], 30_000, 2000);
    const deepestOnPath = (bitsPerSecond: number): number => {
      const plan = new FlightPlan();
      plan.plan(camera(), end, selection(), 1.5, 0, path, { bitsPerSecond });
      return Math.max(...plan.tiles.slice(plan.arrival, plan.count).map((tile) => tile.level));
    };
    // The views along it are as deep as the destination's at four times the texels: the motion's coarsest (F288).
    const moving = new FlightPlan();
    moving.plan(camera(), end, selection(), 1.5 * 4, 0);
    const deepestMoving = Math.max(...moving.tiles.slice(0, moving.arrival).map((tile) => tile.level));
    expect(deepestOnPath(50e6)).toBe(deepestMoving);
    expect(deepestOnPath(400e3)).toBeLessThan(deepestMoving);
  });
});
