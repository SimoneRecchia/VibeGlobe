/**
 * Picking of vector tile features (F459, ADR 0131), on the CPU from the laid-out buckets the frame drew: labels by
 * their placed boxes, buildings by their projected outline (top and base), lines within half their width plus a few
 * pixels, fills by their triangles, circles within their radius. Results come topmost first: labels, then the style
 * layers from the top down.
 */
import type { GeoPosition, ScreenPoint } from '@vibeglobe/core';
import { buildingHeight, type BuildingHeight } from './buildings.js';
import { tileToLonLat } from './globe-vertices.js';
import { BUCKET_EXTENT, type Bucket } from './layout-tile.js';
import type { PlacedLabel } from './label-placer.js';
import type { StyleLayer } from './style-layer.js';
import type { TileId } from './tile-pyramid.js';

/** A picked feature. */
export interface PickedVectorFeature {
  readonly layerId: string;
  readonly source: string;
  readonly sourceLayer: string | undefined;
  readonly id: number | undefined;
  readonly properties: Readonly<Record<string, unknown>>;
  /** Where the feature was picked: the label's anchor, or the ground under the pointer. */
  readonly position: GeoPosition;
  /** Buildings: their top and base heights in meters as extruded, and where the height came from (F455, F458). */
  readonly building?: BuildingHeight;
}

/** A tile the frame drew for a source, with the square it covers. */
export interface DrawnTile {
  readonly source: string;
  readonly tile: TileId;
  readonly clip: readonly [number, number, number, number];
  readonly buckets: readonly Bucket[];
}

/** What picking needs from the globe and the frame. */
export interface PickContext {
  screenToGeo(point: ScreenPoint): GeoPosition | undefined;
  geoToScreen(position: GeoPosition): ScreenPoint | undefined;
  readonly zoom: number;
  readonly layers: readonly StyleLayer[];
  readonly drawn: readonly DrawnTile[];
  readonly labels: readonly PlacedLabel[];
}

/** Extra pixels around lines and circles that still pick them. */
const TOLERANCE_PX = 3;

function inTriangle(px: number, py: number, p: Float32Array, a: number, b: number, c: number, stride: number): boolean {
  const ax = p[a * stride] ?? 0;
  const ay = p[a * stride + 1] ?? 0;
  const bx = p[b * stride] ?? 0;
  const by = p[b * stride + 1] ?? 0;
  const cx = p[c * stride] ?? 0;
  const cy = p[c * stride + 1] ?? 0;
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t =
    dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** The feature of a 2D bucket (fill, line, circle) under a point in tile units, if any. */
function hitFlat(
  layer: StyleLayer,
  bucket: Bucket,
  x: number,
  y: number,
  unitsPerPx: number,
  zoom: number,
): number | undefined {
  const g = bucket.geometry;
  if (g === undefined) return undefined;
  if (layer.type === 'fill') {
    for (let i = 0; i < g.indices.length; i += 3) {
      const a = g.indices[i] ?? 0;
      if (inTriangle(x, y, g.positions, a, g.indices[i + 1] ?? 0, g.indices[i + 2] ?? 0, 2)) return g.featureIndex[a];
    }
  } else if (layer.type === 'line') {
    // Triangles of the center line: the extrusion is in the shader, so test the distance to each vertex pair.
    for (let i = 0; i < g.indices.length; i += 3) {
      const a = g.indices[i] ?? 0;
      const b = g.indices[i + 1] ?? 0;
      const f = g.featureIndex[a] ?? 0;
      const width = Number(layer.paint('line-width', zoom, bucket.features[f])) || 1;
      const d = segmentDistance(
        x,
        y,
        g.positions[a * 2] ?? 0,
        g.positions[a * 2 + 1] ?? 0,
        g.positions[b * 2] ?? 0,
        g.positions[b * 2 + 1] ?? 0,
      );
      if (d / unitsPerPx <= width / 2 + TOLERANCE_PX) return f;
    }
  } else if (layer.type === 'circle') {
    for (let v = 0; v < g.featureIndex.length; v++) {
      const f = g.featureIndex[v] ?? 0;
      const radius = Number(layer.paint('circle-radius', zoom, bucket.features[f])) || 5;
      if (
        Math.hypot(x - (g.positions[v * 2] ?? 0), y - (g.positions[v * 2 + 1] ?? 0)) / unitsPerPx <=
        radius + TOLERANCE_PX
      )
        return f;
    }
  }
  return undefined;
}

/** Whether a screen point lies in the convex hull of points (gift wrapping is overkill: a winding test of the hull). */
function inHull(point: ScreenPoint, points: readonly ScreenPoint[]): boolean {
  if (points.length < 3) return false;
  const sorted = [...points].sort((a, b) => a.xPx - b.xPx || a.yPx - b.yPx);
  const cross = (o: ScreenPoint, a: ScreenPoint, b: ScreenPoint) =>
    (a.xPx - o.xPx) * (b.yPx - o.yPx) - (a.yPx - o.yPx) * (b.xPx - o.xPx);
  const half = (list: ScreenPoint[]) => {
    const out: ScreenPoint[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2] as ScreenPoint, out[out.length - 1] as ScreenPoint, p) <= 0)
        out.pop();
      out.push(p);
    }
    return out;
  };
  const lower = half(sorted);
  const upper = half([...sorted].reverse());
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  return hull.every((a, i) => cross(a, hull[(i + 1) % hull.length] as ScreenPoint, point) >= 0);
}

/** The building under a screen point, nearest the top of the stack first (the tallest when several). */
function hitExtrusion(ctx: PickContext, d: DrawnTile, bucket: Bucket, point: ScreenPoint): number | undefined {
  const g = bucket.geometry;
  if (g === undefined) return undefined;
  const byFeature = new Map<number, ScreenPoint[]>();
  const tops = new Map<number, number>();
  for (let v = 0; v < g.featureIndex.length; v++) {
    const f = g.featureIndex[v] ?? 0;
    const x = g.positions[v * 3] ?? 0;
    const y = g.positions[v * 3 + 1] ?? 0;
    const [lon, lat] = tileToLonLat(d.tile, BUCKET_EXTENT, x, y);
    const screen = ctx.geoToScreen({
      longitudeDeg: lon ?? 0,
      latitudeDeg: lat ?? 0,
      heightMeters: g.positions[v * 3 + 2] ?? 0,
    });
    if (screen === undefined) continue;
    const list = byFeature.get(f) ?? [];
    list.push(screen);
    byFeature.set(f, list);
    tops.set(f, Math.max(tops.get(f) ?? 0, g.positions[v * 3 + 2] ?? 0));
  }
  let best: number | undefined;
  for (const [f, points] of byFeature) {
    if (inHull(point, points) && (best === undefined || (tops.get(f) ?? 0) > (tops.get(best) ?? 0))) best = f;
  }
  return best;
}

/** Every feature under a screen point, topmost first. */
export function pickVectorFeatures(ctx: PickContext, point: ScreenPoint): PickedVectorFeature[] {
  const out: PickedVectorFeature[] = [];
  for (const label of ctx.labels) {
    if (
      !label.boxes.some((b) => point.xPx >= b.minX && point.xPx <= b.maxX && point.yPx >= b.minY && point.yPx <= b.maxY)
    )
      continue;
    const layer = ctx.layers.find((l) => l.id === label.layerId);
    out.push({
      layerId: label.layerId,
      source: label.source,
      sourceLayer: layer?.sourceLayer,
      id: label.feature.id,
      properties: label.feature.properties,
      position: label.position,
    });
  }
  const ground = ctx.screenToGeo(point);
  for (const layer of [...ctx.layers].reverse()) {
    if (layer.type === 'symbol' || layer.type === 'background' || !layer.visible || !layer.inZoomRange(ctx.zoom))
      continue;
    for (const d of ctx.drawn) {
      if (d.source !== layer.source) continue;
      const bucket = d.buckets.find((b) => b.layerId === layer.id);
      if (bucket === undefined) continue;
      let f: number | undefined;
      if (layer.type === 'fill-extrusion') f = hitExtrusion(ctx, d, bucket, point);
      else if (ground !== undefined) {
        const n = 2 ** d.tile.z;
        const lat = (Math.max(-85.0511, Math.min(85.0511, ground.latitudeDeg)) * Math.PI) / 180;
        const wx = (ground.longitudeDeg + 180) / 360;
        const wy = 0.5 - Math.log((1 + Math.sin(lat)) / (1 - Math.sin(lat))) / (4 * Math.PI);
        const x = (wx * n - d.tile.x) * BUCKET_EXTENT;
        const y = (wy * n - d.tile.y) * BUCKET_EXTENT;
        if (x < d.clip[0] || y < d.clip[1] || x >= d.clip[2] || y >= d.clip[3]) continue;
        f = hitFlat(layer, bucket, x, y, BUCKET_EXTENT / (512 * 2 ** (ctx.zoom - d.tile.z)), ctx.zoom);
      }
      const feature = f === undefined ? undefined : bucket.features[f];
      if (feature === undefined || ground === undefined) continue;
      out.push({
        layerId: layer.id,
        source: d.source,
        sourceLayer: layer.sourceLayer,
        id: feature.id,
        properties: feature.properties,
        position: ground,
        ...(layer.type === 'fill-extrusion' ? { building: buildingHeight(feature.properties) } : {}),
      });
      break;
    }
  }
  return out;
}
