// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { type FrameView, type LayerGround } from '@vibeglobe/core';
import { projectLayerPoint } from '@vibeglobe/core/layers';
import { nearPoints } from './layer-pick-grid.js';
import { valueOf, type BatchContents } from './layer-geometry.js';

/** How far from a feature's drawn shape a pointer still picks it, CSS pixels. */
const TOLERANCE_PX = 3;

const a = new Float64Array(2);
const b = new Float64Array(2);

/** Distance from a point to the segment a–b, pixels. */
function segmentDistance(x: number, y: number): number {
  const ax = a[0] ?? 0;
  const ay = a[1] ?? 0;
  const dx = (b[0] ?? 0) - ax;
  const dy = (b[1] ?? 0) - ay;
  const length2 = dx * dx + dy * dy;
  const t = length2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length2)) : 0;
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

const c = new Float64Array(2);
const d = new Float64Array(2);

/**
 * Projects vertex `i` of a feature's positions, on the terrain when the batch stands on it; at `height` instead of its
 * own when given (an extrusion's base or roof).
 */
function projectVertex(
  view: FrameView,
  p: ArrayLike<number>,
  i: number,
  ground: LayerGround | undefined,
  out: Float64Array,
  height?: number,
): boolean {
  const lon = p[i * 3] ?? 0;
  const lat = p[i * 3 + 1] ?? 0;
  return projectLayerPoint(view, lon, lat, (height ?? p[i * 3 + 2] ?? 0) + (ground?.heightAt(lon, lat) ?? 0), out);
}

/** Whether (x, y) lies inside the quadrilateral a, b, c, d (an extrusion's wall as projected). */
function insideQuad(x: number, y: number): boolean {
  let inside = false;
  const corners = [a, b, c, d];
  for (let i = 0; i < 4; i++) {
    const u = corners[i] as Float64Array;
    const v = corners[(i + 1) % 4] as Float64Array;
    const uy = u[1] ?? 0;
    const vy = v[1] ?? 0;
    if (uy > y !== vy > y && x < (u[0] ?? 0) + ((y - uy) / (vy - uy)) * ((v[0] ?? 0) - (u[0] ?? 0))) inside = !inside;
  }
  return inside;
}

/**
 * How far a feature is from the point, pixels (0 inside it), or Infinity when it does not reach it; clamped and draped
 * features where they stand on the terrain (`ground`), as drawn.
 */
function featureDistance(
  batch: BatchContents,
  feature: number,
  view: FrameView,
  x: number,
  y: number,
  ground: LayerGround | undefined,
): number {
  if (batch.kind !== 'polyline' && batch.kind !== 'polygon' && batch.kind !== 'circle') {
    const lon = valueOf(batch, 'position', feature, 0);
    const lat = valueOf(batch, 'position', feature, 1);
    const height = valueOf(batch, 'position', feature, 2) + (ground?.heightAt(lon, lat) ?? 0);
    if (!projectLayerPoint(view, lon, lat, height, a)) return Infinity;
    const radius = batch.kind === 'point' ? valueOf(batch, 'sizePx', feature) : 12;
    const center = Math.hypot(x - (a[0] ?? 0), y - (a[1] ?? 0));
    // Overlapping points: the one whose center is nearest wins (a thousandth of the center distance breaks the tie).
    return Math.max(0, center - radius) + center * 1e-3;
  }
  const geometry = batch.geometry.get(feature);
  if (!geometry) return Infinity;
  const top = batch.kind === 'polygon' ? valueOf(batch, 'heightMeters', feature) : 0;
  if (top <= 0) return ringsDistance(batch, feature, geometry.positions, geometry.partStarts, view, x, y, ground);
  // An extrusion (F355): its roof, its base and its walls, as drawn.
  const base = valueOf(batch, 'baseMeters', feature);
  const p = geometry.positions;
  let best = Math.min(
    ringsDistance(batch, feature, p, geometry.partStarts, view, x, y, ground, top),
    ringsDistance(batch, feature, p, geometry.partStarts, view, x, y, ground, base),
  );
  for (let part = 0; part < geometry.partStarts.length && best > 0; part++) {
    const start = geometry.partStarts[part] ?? 0;
    const end = geometry.partStarts[part + 1] ?? p.length / 3;
    for (let i = start; i < end; i++) {
      const j = i + 1 < end ? i + 1 : start;
      if (
        projectVertex(view, p, i, ground, a, base) &&
        projectVertex(view, p, j, ground, b, base) &&
        projectVertex(view, p, j, ground, c, top) &&
        projectVertex(view, p, i, ground, d, top) &&
        insideQuad(x, y)
      )
        best = 0;
    }
  }
  return best;
}

/** How far the point is from a feature's rings (0 inside a closed one), at their own heights or at `height`. */
function ringsDistance(
  batch: BatchContents,
  feature: number,
  p: ArrayLike<number>,
  partStarts: ArrayLike<number>,
  view: FrameView,
  x: number,
  y: number,
  ground: LayerGround | undefined,
  height?: number,
): number {
  const half = batch.kind === 'polyline' ? valueOf(batch, 'widthPx', feature) / 2 : 0;
  let best = Infinity;
  let inside = false;
  for (let part = 0; part < partStarts.length; part++) {
    const start = partStarts[part] ?? 0;
    const end = partStarts[part + 1] ?? p.length / 3;
    const closed = batch.kind !== 'polyline';
    for (let i = start; i < end - (closed ? 0 : 1); i++) {
      const j = i + 1 < end ? i + 1 : start;
      if (!projectVertex(view, p, i, ground, a, height) || !projectVertex(view, p, j, ground, b, height)) continue;
      best = Math.min(best, Math.max(0, segmentDistance(x, y) - half));
      const ay = a[1] ?? 0;
      const by = b[1] ?? 0;
      if (closed && ay > y !== by > y) {
        const crossX = (a[0] ?? 0) + ((y - ay) / (by - ay)) * ((b[0] ?? 0) - (a[0] ?? 0));
        if (x < crossX) inside = !inside;
      }
    }
  }
  return inside ? 0 : best;
}

/**
 * The pick id of the feature drawn at a screen point (ADR 0037): among the visible batches, the topmost one in draw
 * order with a feature within {@link TOLERANCE_PX}, and in it the nearest; 0 when none. Projects on the CPU with the
 * frame's own morph, so it agrees with what was drawn.
 */
export function pickAt<B extends BatchContents & { readonly visible: boolean; readonly order: number }>(
  batches: Iterable<B>,
  view: FrameView,
  xPx: number,
  yPx: number,
  groundOf: (batch: B) => LayerGround | undefined = () => undefined,
): number {
  let bestId = 0;
  let bestOrder = -Infinity;
  let bestDistance = Infinity;
  for (const batch of batches) {
    if (!batch.visible || batch.order < bestOrder) continue;
    const ground = groundOf(batch);
    const consider = (feature: number, distance: number): void => {
      if (distance > TOLERANCE_PX) return;
      const id = valueOf(batch, 'pickId', feature);
      if (id === 0 || valueOf(batch, 'visible', feature) <= 0) return;
      if (batch.order > bestOrder || distance < bestDistance) {
        bestId = id;
        bestOrder = batch.order;
        bestDistance = distance;
      }
    };
    // Points, markers and labels through their screen grid, projected once per view (F379); shapes one by one.
    if (batch.kind !== 'polyline' && batch.kind !== 'polygon' && batch.kind !== 'circle')
      nearPoints(batch, view, ground, xPx, yPx, TOLERANCE_PX, consider);
    else
      for (let feature = 0; feature < batch.count; feature++)
        consider(feature, featureDistance(batch, feature, view, xPx, yPx, ground));
  }
  return bestId;
}
