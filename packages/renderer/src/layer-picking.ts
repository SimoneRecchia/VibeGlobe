import { projectLayerPoint, type FrameView } from '@vibeglobe/core';
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

/** How far a feature is from the point, pixels (0 inside it), or Infinity when it does not reach it. */
function featureDistance(batch: BatchContents, feature: number, view: FrameView, x: number, y: number): number {
  if (batch.kind !== 'polyline' && batch.kind !== 'polygon' && batch.kind !== 'circle') {
    const lon = valueOf(batch, 'position', feature, 0);
    const lat = valueOf(batch, 'position', feature, 1);
    if (!projectLayerPoint(view, lon, lat, valueOf(batch, 'position', feature, 2), a)) return Infinity;
    const radius = batch.kind === 'point' ? valueOf(batch, 'sizePx', feature) : 12;
    const center = Math.hypot(x - (a[0] ?? 0), y - (a[1] ?? 0));
    // Overlapping points: the one whose center is nearest wins (a thousandth of the center distance breaks the tie).
    return Math.max(0, center - radius) + center * 1e-3;
  }
  const geometry = batch.geometry.get(feature);
  if (!geometry) return Infinity;
  const p = geometry.positions;
  const half = batch.kind === 'polyline' ? valueOf(batch, 'widthPx', feature) / 2 : 0;
  let best = Infinity;
  let inside = false;
  for (let part = 0; part < geometry.partStarts.length; part++) {
    const start = geometry.partStarts[part] ?? 0;
    const end = geometry.partStarts[part + 1] ?? p.length / 3;
    const closed = batch.kind !== 'polyline';
    for (let i = start; i < end - (closed ? 0 : 1); i++) {
      const j = i + 1 < end ? i + 1 : start;
      if (!projectLayerPoint(view, p[i * 3] ?? 0, p[i * 3 + 1] ?? 0, p[i * 3 + 2] ?? 0, a)) continue;
      if (!projectLayerPoint(view, p[j * 3] ?? 0, p[j * 3 + 1] ?? 0, p[j * 3 + 2] ?? 0, b)) continue;
      best = Math.min(best, Math.max(0, segmentDistance(x, y) - half));
      // Even-odd crossing test of the ring's projected edges: holes cancel out.
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
export function pickAt(
  batches: Iterable<BatchContents & { readonly visible: boolean; readonly order: number }>,
  view: FrameView,
  xPx: number,
  yPx: number,
): number {
  let bestId = 0;
  let bestOrder = -Infinity;
  let bestDistance = Infinity;
  for (const batch of batches) {
    if (!batch.visible || batch.order < bestOrder) continue;
    for (let feature = 0; feature < batch.count; feature++) {
      const id = valueOf(batch, 'pickId', feature);
      if (id === 0 || valueOf(batch, 'visible', feature) <= 0) continue;
      const distance = featureDistance(batch, feature, view, xPx, yPx);
      if (distance > TOLERANCE_PX) continue;
      if (batch.order > bestOrder || distance < bestDistance) {
        bestId = id;
        bestOrder = batch.order;
        bestDistance = distance;
      }
    }
  }
  return bestId;
}
