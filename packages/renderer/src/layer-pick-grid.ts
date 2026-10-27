// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { FrameView, LayerGround } from '@vibeglobe/core';
import { projectLayerPoint } from '@vibeglobe/core/layers';
import { valueOf, type BatchContents } from './layer-contents.js';

/**
 * A screen-space grid of a point-like batch's features (F379): every feature projected once per view and binned in
 * cells of {@link CELL_PX}, so a hover pick on a still view reads the cells around the pointer instead of projecting
 * every feature again (a 100,000-point layer took 20–40 ms a pick). Rebuilt when the view, the batch or the terrain
 * under it changes.
 */
interface PickGrid {
  revision: number;
  groundVersion: number;
  /** The view it was built for: view and projection matrices, size and morph (see {@link sameView}). */
  readonly key: Float64Array;
  xs: Float32Array;
  ys: Float32Array;
  reach: Float32Array;
  maxReach: number;
  columns: number;
  rows: number;
  heads: Int32Array;
  next: Int32Array;
}

/** Cell size of the grid, CSS pixels. */
const CELL_PX = 32;
const KEY_LENGTH = 16 + 16 + 2 + 3 + 2;
const revisions = new WeakMap<object, number>();
const grids = new WeakMap<object, PickGrid>();
const point = new Float64Array(3);

/** True when two attribute values hold the same components. */
export function sameValues(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Marks a batch to be rebuilt on the next frame, its grid at the next pick. */
export function rebuildLater(batch: { dirty: boolean }): void {
  batch.dirty = true;
  touchBatch(batch);
}

/** Records a change to a batch's features: its grid is rebuilt at the next pick. */
export function touchBatch(batch: object): void {
  revisions.set(batch, (revisions.get(batch) ?? 0) + 1);
}

/** Writes what a grid depends on of a view into `key`; returns whether it was already there. */
function sameView(view: FrameView, key: Float64Array): boolean {
  let same = true;
  let k = 0;
  const write = (value: number): void => {
    if (key[k] !== value) {
      key[k] = value;
      same = false;
    }
    k++;
  };
  for (let i = 0; i < 16; i++) write(view.view[i] ?? 0);
  for (let i = 0; i < 16; i++) write(view.projection[i] ?? 0);
  write(view.widthPx);
  write(view.heightPx);
  for (let i = 0; i < 3; i++) write(view.morph.factors[i] ?? 0);
  for (let i = 0; i < 2; i++) write(view.morph.anchor[i] ?? 0);
  return same;
}

/** The grid of a batch for a view, built or brought up to date. */
function gridOf(batch: BatchContents, view: FrameView, ground: LayerGround | undefined): PickGrid {
  let grid = grids.get(batch);
  const revision = revisions.get(batch) ?? 0;
  const groundVersion = ground?.version() ?? -1;
  if (!grid) {
    grid = {
      revision: -1,
      groundVersion,
      key: new Float64Array(KEY_LENGTH).fill(Number.NaN),
      xs: new Float32Array(0),
      ys: new Float32Array(0),
      reach: new Float32Array(0),
      maxReach: 0,
      columns: 0,
      rows: 0,
      heads: new Int32Array(0),
      next: new Int32Array(0),
    };
    grids.set(batch, grid);
  }
  const sameKey = sameView(view, grid.key);
  if (sameKey && grid.revision === revision && grid.groundVersion === groundVersion) return grid;
  grid.revision = revision;
  grid.groundVersion = groundVersion;
  build(grid, batch, view, ground);
  return grid;
}

/** Projects every feature of a batch and bins it by the cell of its center. */
function build(grid: PickGrid, batch: BatchContents, view: FrameView, ground: LayerGround | undefined): void {
  const count = batch.count;
  if (grid.xs.length < count) {
    grid.xs = new Float32Array(count);
    grid.ys = new Float32Array(count);
    grid.reach = new Float32Array(count);
    grid.next = new Int32Array(count);
  }
  grid.columns = Math.max(1, Math.ceil(view.widthPx / CELL_PX));
  grid.rows = Math.max(1, Math.ceil(view.heightPx / CELL_PX));
  if (grid.heads.length < grid.columns * grid.rows) grid.heads = new Int32Array(grid.columns * grid.rows);
  grid.heads.fill(-1, 0, grid.columns * grid.rows);
  grid.maxReach = 0;
  for (let feature = 0; feature < count; feature++) {
    const lon = valueOf(batch, 'position', feature, 0);
    const lat = valueOf(batch, 'position', feature, 1);
    const height = valueOf(batch, 'position', feature, 2) + (ground?.heightAt(lon, lat) ?? 0);
    if (!projectLayerPoint(view, lon, lat, height, point)) continue;
    const x = point[0] ?? 0;
    const y = point[1] ?? 0;
    const column = Math.floor(x / CELL_PX);
    const row = Math.floor(y / CELL_PX);
    // Features off the screen are kept at the nearest edge cell: their discs may still reach into it.
    const cell =
      Math.min(grid.rows - 1, Math.max(0, row)) * grid.columns + Math.min(grid.columns - 1, Math.max(0, column));
    const reach = batch.kind === 'point' ? valueOf(batch, 'sizePx', feature) : 12;
    grid.xs[feature] = x;
    grid.ys[feature] = y;
    grid.reach[feature] = reach;
    if (reach > grid.maxReach) grid.maxReach = reach;
    grid.next[feature] = grid.heads[cell] ?? -1;
    grid.heads[cell] = feature;
  }
}

/**
 * Calls `visit` with each feature of a point-like batch (points, markers, labels) whose center lies within
 * `tolerancePx` plus its own radius of (x, y), and its distance as {@link pickAt} measures it: from the edge of its disc
 * (0 inside), a thousandth of the center distance breaking ties.
 */
export function nearPoints(
  batch: BatchContents,
  view: FrameView,
  ground: LayerGround | undefined,
  x: number,
  y: number,
  tolerancePx: number,
  visit: (feature: number, distance: number) => void,
): void {
  const grid = gridOf(batch, view, ground);
  const range = tolerancePx + grid.maxReach;
  const firstColumn = Math.max(0, Math.floor((x - range) / CELL_PX));
  const lastColumn = Math.min(grid.columns - 1, Math.floor((x + range) / CELL_PX));
  const firstRow = Math.max(0, Math.floor((y - range) / CELL_PX));
  const lastRow = Math.min(grid.rows - 1, Math.floor((y + range) / CELL_PX));
  for (let row = firstRow; row <= lastRow; row++)
    for (let column = firstColumn; column <= lastColumn; column++)
      for (
        let feature = grid.heads[row * grid.columns + column] ?? -1;
        feature >= 0;
        feature = grid.next[feature] ?? -1
      ) {
        const center = Math.hypot(x - (grid.xs[feature] ?? 0), y - (grid.ys[feature] ?? 0));
        visit(feature, Math.max(0, center - (grid.reach[feature] ?? 0)) + center * 1e-3);
      }
}
