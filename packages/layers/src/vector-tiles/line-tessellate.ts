/**
 * Line tessellation for vector-tile lines (F440, F443), original code (ADR 0041). Each vertex carries its point on the
 * center line, an extrusion vector in units of half the line width, and the distance along the line; the renderer
 * multiplies the extrusion by `line-width / 2` in pixels. Widths are therefore paint values: they change continuously
 * with fractional zoom and at runtime without tessellating again (F450). Joins are miter (falling back to bevel past
 * the miter limit), bevel or round; caps butt, square or round. A line clipped at the tile buffer gets no cap there,
 * so where a line crosses a tile edge the two tiles meet without a gap or a doubled cap.
 */
import type { ClipRect, TilePoint, TileRing } from './fill-tessellate.js';

/** `line-join` values. */
export type LineJoin = 'miter' | 'bevel' | 'round';
/** `line-cap` values. */
export type LineCap = 'butt' | 'square' | 'round';

/** Tessellation options from the layer's layout properties. */
export interface LineOptions {
  readonly join: LineJoin;
  readonly cap: LineCap;
  /** `line-miter-limit` (default 2). */
  readonly miterLimit: number;
  /** Segments per half turn of round joins and caps. */
  readonly roundSegments?: number;
}

/**
 * Line triangles. Per vertex: `positions` (x, y on the center line), `extrusions` (ex, ey; length 1 is half the line
 * width) and `distances` (tile units along the line, for dashes and gradients).
 */
export interface LineGeometry {
  readonly positions: Float32Array;
  readonly extrusions: Float32Array;
  readonly distances: Float32Array;
  readonly indices: Uint32Array;
}

class Builder {
  readonly positions: number[] = [];
  readonly extrusions: number[] = [];
  readonly distances: number[] = [];
  readonly indices: number[] = [];

  vertex(p: TilePoint, ex: number, ey: number, distance: number): number {
    this.positions.push(p[0], p[1]);
    this.extrusions.push(ex, ey);
    this.distances.push(distance);
    return this.distances.length - 1;
  }

  triangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  /** A fan of triangles around `center` from angle `from` to `to` (radians, shortest way). */
  fan(p: TilePoint, center: number, from: number, to: number, distance: number, segments: number): void {
    let delta = to - from;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    const steps = Math.max(1, Math.ceil((Math.abs(delta) / Math.PI) * segments));
    let previous = this.vertex(p, Math.cos(from), Math.sin(from), distance);
    for (let i = 1; i <= steps; i++) {
      const angle = from + (delta * i) / steps;
      const next = this.vertex(p, Math.cos(angle), Math.sin(angle), distance);
      this.triangle(center, previous, next);
      previous = next;
    }
  }

  build(): LineGeometry {
    return {
      positions: new Float32Array(this.positions),
      extrusions: new Float32Array(this.extrusions),
      distances: new Float32Array(this.distances),
      indices: new Uint32Array(this.indices),
    };
  }
}

/** The unit normal (left of the direction a → b, y down). */
function normal(a: TilePoint, b: TilePoint): [number, number] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy);
  return [dy / length, -dx / length];
}

function withoutRepeats(line: TileRing): TilePoint[] {
  const out: TilePoint[] = [];
  for (const p of line) {
    const last = out.at(-1);
    if (last === undefined || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  return out;
}

function onClipEdge(p: TilePoint, rect: ClipRect | undefined): boolean {
  if (rect === undefined) return false;
  return p[0] <= rect.minX || p[0] >= rect.maxX || p[1] <= rect.minY || p[1] >= rect.maxY;
}

function addCap(
  b: Builder,
  p: TilePoint,
  n: readonly [number, number],
  start: boolean,
  cap: LineCap,
  distance: number,
  segments: number,
): void {
  if (cap === 'butt') return;
  // Direction pointing out of the line at this end.
  const out: [number, number] = start ? [n[1], -n[0]] : [-n[1], n[0]];
  if (cap === 'square') {
    const l = b.vertex(p, n[0], n[1], distance);
    const r = b.vertex(p, -n[0], -n[1], distance);
    const lo = b.vertex(p, n[0] + out[0], n[1] + out[1], distance);
    const ro = b.vertex(p, -n[0] + out[0], -n[1] + out[1], distance);
    b.triangle(l, r, lo);
    b.triangle(r, ro, lo);
    return;
  }
  const center = b.vertex(p, 0, 0, distance);
  const angle = Math.atan2(n[1], n[0]);
  b.fan(p, center, angle, angle + (start ? -Math.PI / 2 : Math.PI / 2), distance, segments);
  b.fan(
    p,
    center,
    angle + (start ? -Math.PI / 2 : Math.PI / 2),
    angle + (start ? -Math.PI : Math.PI),
    distance,
    segments,
  );
}

function addJoin(
  b: Builder,
  p: TilePoint,
  n0: readonly [number, number],
  n1: readonly [number, number],
  options: LineOptions,
  distance: number,
): void {
  const cross = n0[0] * n1[1] - n0[1] * n1[0];
  if (Math.abs(cross) < 1e-9 && n0[0] * n1[0] + n0[1] * n1[1] > 0) return;
  // The outer side of the turn: left (+n) when turning right (positive cross product, y down).
  const side = cross > 0 ? 1 : -1;
  const center = b.vertex(p, 0, 0, distance);
  const mx = n0[0] + n1[0];
  const my = n0[1] + n1[1];
  const mLength = Math.hypot(mx, my);
  const miter = mLength > 1e-9 ? 2 / mLength : Infinity;
  const segments = options.roundSegments ?? 8;
  if (options.join === 'round') {
    b.fan(
      p,
      center,
      Math.atan2(side * n0[1], side * n0[0]),
      Math.atan2(side * n1[1], side * n1[0]),
      distance,
      segments,
    );
    return;
  }
  const a = b.vertex(p, side * n0[0], side * n0[1], distance);
  const c = b.vertex(p, side * n1[0], side * n1[1], distance);
  if (options.join === 'miter' && miter <= options.miterLimit) {
    const tip = b.vertex(p, (side * mx * miter) / mLength, (side * my * miter) / mLength, distance);
    b.triangle(center, a, tip);
    b.triangle(center, tip, c);
  } else {
    b.triangle(center, a, c);
  }
}

/**
 * Tessellates one line. Segments are quads; joins fill the outer side of each turn; caps are added at ends that are
 * not on the edge of `clip` (the tile's clip rectangle, when the line was clipped).
 */
export function tessellateLine(line: TileRing, options: LineOptions, clip?: ClipRect): LineGeometry {
  const out = new Builder();
  const points = withoutRepeats(line);
  if (points.length < 2) return out.build();
  const segments = options.roundSegments ?? 8;
  let distance = 0;
  let previousNormal: [number, number] | undefined;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i] as TilePoint;
    const c = points[i + 1] as TilePoint;
    const n = normal(a, c);
    const length = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (previousNormal === undefined) {
      if (!onClipEdge(a, clip)) addCap(out, a, n, true, options.cap, distance, segments);
    } else {
      addJoin(out, a, previousNormal, n, options, distance);
    }
    const al = out.vertex(a, n[0], n[1], distance);
    const ar = out.vertex(a, -n[0], -n[1], distance);
    const cl = out.vertex(c, n[0], n[1], distance + length);
    const cr = out.vertex(c, -n[0], -n[1], distance + length);
    out.triangle(al, ar, cl);
    out.triangle(ar, cr, cl);
    distance += length;
    previousNormal = n;
  }
  const end = points.at(-1) as TilePoint;
  if (previousNormal !== undefined && !onClipEdge(end, clip))
    addCap(out, end, previousNormal, false, options.cap, distance, segments);
  return out.build();
}

function clipSegment(a: TilePoint, b: TilePoint, rect: ClipRect): [TilePoint, TilePoint, boolean] | undefined {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const checks: [number, number][] = [
    [-dx, a[0] - rect.minX],
    [dx, rect.maxX - a[0]],
    [-dy, a[1] - rect.minY],
    [dy, rect.maxY - a[1]],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) return undefined;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return undefined;
  }
  return [[a[0] + t0 * dx, a[1] + t0 * dy], [a[0] + t1 * dx, a[1] + t1 * dy], t1 < 1];
}

/** Clips a line to a rectangle (Liang–Barsky per segment), splitting it where it leaves and re-enters. */
export function clipLine(line: TileRing, rect: ClipRect): TilePoint[][] {
  const parts: TilePoint[][] = [];
  let current: TilePoint[] | undefined;
  for (let i = 0; i < line.length - 1; i++) {
    const clipped = clipSegment(line[i] as TilePoint, line[i + 1] as TilePoint, rect);
    if (clipped === undefined) {
      current = undefined;
      continue;
    }
    const [a, b, leaves] = clipped;
    const last = current?.at(-1);
    if (current === undefined || last === undefined || last[0] !== a[0] || last[1] !== a[1]) {
      current = [a];
      parts.push(current);
    }
    current.push(b);
    if (leaves) current = undefined;
  }
  return parts;
}
