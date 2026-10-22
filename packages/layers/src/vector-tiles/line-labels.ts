/**
 * Labels along lines (F449), original code (ADR 0034): anchors every `symbol-spacing` along a line, refused where the
 * line bends more than `text-max-angle` under the label, and each glyph placed on the line with its own rotation,
 * kept upright. A tile keeps only the anchors inside its own extent (not in the buffer), so a road that crosses a
 * tile boundary is labelled by one tile, never by both.
 */
import type { TilePoint, TileRing } from './fill-tessellate.js';

/** A label anchor on a line, in tile coordinates. */
export interface LineAnchor {
  readonly x: number;
  readonly y: number;
  /** Direction of the line at the anchor, radians (y down). */
  readonly angleRad: number;
  /** Index of the segment the anchor lies on. */
  readonly segment: number;
  /** Distance of the anchor from the line start, tile units. */
  readonly distance: number;
}

function cumulative(line: TileRing): number[] {
  const out = [0];
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1] as TilePoint;
    const b = line[i] as TilePoint;
    out.push((out[i - 1] ?? 0) + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return out;
}

/** The point, direction and segment at a distance along a line; undefined beyond its ends. */
export function pointAlong(line: TileRing, distances: readonly number[], at: number): LineAnchor | undefined {
  if (at < 0 || at > (distances.at(-1) ?? 0)) return undefined;
  for (let i = 1; i < line.length; i++) {
    const end = distances[i] ?? 0;
    if (at > end && i < line.length - 1) continue;
    const start = distances[i - 1] ?? 0;
    const a = line[i - 1] as TilePoint;
    const b = line[i] as TilePoint;
    const t = end > start ? (at - start) / (end - start) : 0;
    return {
      x: a[0] + t * (b[0] - a[0]),
      y: a[1] + t * (b[1] - a[1]),
      angleRad: Math.atan2(b[1] - a[1], b[0] - a[0]),
      segment: i - 1,
      distance: at,
    };
  }
  return undefined;
}

function turnBetween(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}

/** The total change of direction at the vertices within `window` tile units centred on `at`, in radians. */
function bendUnder(line: TileRing, distances: readonly number[], at: number, window: number): number {
  let total = 0;
  for (let i = 1; i < line.length - 1; i++) {
    const vertexDistance = distances[i] ?? 0;
    if (vertexDistance <= at - window / 2 || vertexDistance >= at + window / 2) continue;
    const a = line[i - 1] as TilePoint;
    const b = line[i] as TilePoint;
    const c = line[i + 1] as TilePoint;
    total += turnBetween(Math.atan2(b[1] - a[1], b[0] - a[0]), Math.atan2(c[1] - b[1], c[0] - b[0]));
  }
  return total;
}

/** Options for anchors along a line, in tile units (convert pixels with the tile's pixels per unit). */
export interface LineAnchorOptions {
  /** `symbol-spacing`. */
  readonly spacing: number;
  /** The label's length along the line. */
  readonly labelLength: number;
  /** `text-max-angle`, in degrees (default 45). */
  readonly maxAngleDeg: number;
  /** The tile extent; only anchors in [0, extent) on both axes are kept. */
  readonly extent: number;
}

/**
 * Anchors for one line. A line shorter than the label gets none; a line shorter than the spacing gets one at its
 * middle; otherwise anchors sit every `spacing`, the first half a spacing from the start.
 */
export function lineAnchors(line: TileRing, options: LineAnchorOptions): LineAnchor[] {
  const distances = cumulative(line);
  const total = distances.at(-1) ?? 0;
  if (total < options.labelLength || line.length < 2) return [];
  const spacing = Math.max(options.spacing, options.labelLength);
  const positions: number[] = [];
  if (total < spacing) positions.push(total / 2);
  else for (let at = spacing / 2; at <= total - options.labelLength / 2; at += spacing) positions.push(at);
  const maxBend = (options.maxAngleDeg * Math.PI) / 180;
  const anchors: LineAnchor[] = [];
  for (const at of positions) {
    if (at < options.labelLength / 2 || at > total - options.labelLength / 2) continue;
    const anchor = pointAlong(line, distances, at);
    if (anchor === undefined) continue;
    if (anchor.x < 0 || anchor.y < 0 || anchor.x >= options.extent || anchor.y >= options.extent) continue;
    if (bendUnder(line, distances, at, options.labelLength) > maxBend) continue;
    anchors.push(anchor);
  }
  return anchors;
}

/** A glyph placed on a line. */
export interface GlyphOnLine {
  readonly x: number;
  readonly y: number;
  readonly angleRad: number;
}

/**
 * Places glyphs along a line around an anchor. `offsets` are the glyph centres along the label, relative to its
 * middle, in tile units. The text runs in the line's direction unless that would turn it upside down, in which case
 * it runs backwards. Undefined when a glyph would fall off the line.
 */
export function placeGlyphsAlongLine(
  line: TileRing,
  anchor: LineAnchor,
  offsets: readonly number[],
): GlyphOnLine[] | undefined {
  const distances = cumulative(line);
  const upright = Math.cos(anchor.angleRad) >= 0;
  const direction = upright ? 1 : -1;
  const placed: GlyphOnLine[] = [];
  for (const offset of offsets) {
    const point = pointAlong(line, distances, anchor.distance + direction * offset);
    if (point === undefined) return undefined;
    placed.push({ x: point.x, y: point.y, angleRad: upright ? point.angleRad : point.angleRad + Math.PI });
  }
  return placed;
}
