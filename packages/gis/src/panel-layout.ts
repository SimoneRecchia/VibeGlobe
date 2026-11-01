// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Lays out identical rectangles, such as the tables of a solar park, in rows inside one or more perimeters (F658):
 * rows run along a bearing and fill from the far side across them, panels already placed by hand keep their places
 * and the others go around them, and all the panels shrink alike when the perimeters cannot hold them at their size.
 * A panel dragged onto others makes them shift along the rows (F681), and panels left without room line up outside
 * (F682). A scanline over each row's band keeps it fast enough to run on every drag of a panel.
 */
import type { LonLat } from './format.js';

const METERS_PER_DEGREE = 111_320;
const DEG = Math.PI / 180;
const SCALE_STEPS = 14;
const PHASES = 4;

/** Options of {@link layoutPanels}. */
export interface PanelLayoutOptions {
  /** The areas the panels must stay inside: each an outer ring of positions, open or closed. */
  readonly perimeters: readonly (readonly LonLat[])[];
  /** How many panels to place, the fixed ones not included. */
  readonly count: number;
  /** A panel's size in meters: along its row, and across it. */
  readonly widthM: number;
  readonly depthM: number;
  /** The rows' direction, a compass bearing in degrees (default 90: rows east–west). */
  readonly rowBearingDeg?: number;
  /** Space between neighbours in a row and between rows, meters (defaults 0.5 and the panel's depth). */
  readonly gapM?: number;
  readonly rowGapM?: number;
  /** Centers of panels that keep their places (locked, or being moved by hand): the others go around them. */
  readonly fixed?: readonly LonLat[];
  /** Where each panel to place would like to be (its real position), or undefined to take the next free place. */
  readonly wanted?: readonly (LonLat | undefined)[];
  /** The smallest size, as a share of the given one, the panels may shrink to (default 0.85). */
  readonly minScale?: number;
  /**
   * A panel center the rows pass through (F677): a panel seen in an aerial image, or one already placed, so the
   * rows line up with it; by default the rows take the phase that holds the most panels.
   */
  readonly anchor?: LonLat;
  /**
   * Panels moved by hand, by index, in the order they are placed (F681): each takes the place nearest its wanted
   * position, and the panels in the way shift along the rows, in order, toward the nearest free place, so none overlaps
   * and the rows keep their order. The others take the free places nearest their wanted positions first.
   */
  readonly moving?: readonly number[];
  /** Whether panels left without room line up in rows beyond the last one, outside the perimeters (F682). */
  readonly spill?: boolean;
}

/** A layout: each panel's center (undefined when no place was left and none spill) and the size share they were given. */
export interface PanelLayout {
  readonly centers: readonly (LonLat | undefined)[];
  readonly scale: number;
}

type Point = readonly [number, number];
type Interval = readonly [number, number];

/** A local frame: meters east and north of an origin, turned so that x runs along the rows and y across them. */
class Frame {
  readonly #lon0: number;
  readonly #lat0: number;
  readonly #kx: number;
  readonly #sin: number;
  readonly #cos: number;

  constructor(points: readonly LonLat[], bearingDeg: number) {
    this.#lon0 = points.reduce((sum, p) => sum + p.longitudeDeg, 0) / Math.max(1, points.length);
    this.#lat0 = points.reduce((sum, p) => sum + p.latitudeDeg, 0) / Math.max(1, points.length);
    this.#kx = METERS_PER_DEGREE * Math.cos(this.#lat0 * DEG);
    this.#sin = Math.sin(bearingDeg * DEG);
    this.#cos = Math.cos(bearingDeg * DEG);
  }

  toLocal(p: LonLat): Point {
    const east = (p.longitudeDeg - this.#lon0) * this.#kx;
    const north = (p.latitudeDeg - this.#lat0) * METERS_PER_DEGREE;
    return [east * this.#sin + north * this.#cos, -east * this.#cos + north * this.#sin];
  }

  toLonLat([x, y]: Point): LonLat {
    const east = x * this.#sin - y * this.#cos;
    const north = x * this.#cos + y * this.#sin;
    return { longitudeDeg: this.#lon0 + east / this.#kx, latitudeDeg: this.#lat0 + north / METERS_PER_DEGREE };
  }
}

/** The x ranges inside a ring along the line at `y` (even–odd). */
function insideAt(ring: readonly Point[], y: number): Interval[] {
  const xs: number[] = [];
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i] as Point;
    const [bx, by] = ring[(i + 1) % ring.length] as Point;
    if (ay <= y === by <= y) continue;
    xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
  }
  xs.sort((a, b) => a - b);
  const out: Interval[] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i] as number, xs[i + 1] as number]);
  return out;
}

function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [a0, a1] of a)
    for (const [b0, b1] of b) {
      const lo = Math.max(a0, b0);
      const hi = Math.min(a1, b1);
      if (hi > lo) out.push([lo, hi]);
    }
  return out;
}

function subtract(from: readonly Interval[], [c0, c1]: Interval): Interval[] {
  return from.flatMap(([a0, a1]): Interval[] => {
    if (c1 <= a0 || c0 >= a1) return [[a0, a1]];
    return [...(c0 > a0 ? [[a0, c0] as Interval] : []), ...(c1 < a1 ? [[c1, a1] as Interval] : [])];
  });
}

/** The x ranges inside a ring for the whole band from `y0` to `y1`. */
function insideBand(ring: readonly Point[], y0: number, y1: number): Interval[] {
  let ranges = insideAt(ring, y0 + 1e-9);
  for (const y of [y1 - 1e-9, ...ring.map(([, vy]) => vy).filter((vy) => vy > y0 && vy < y1)])
    ranges = intersect(ranges, insideAt(ring, y));
  return ranges;
}

interface Grid {
  readonly rings: readonly (readonly Point[])[];
  readonly fixed: readonly Point[];
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/** Every place a panel fits at a scale and grid phase, rows from the far side, left to right along each row. */
type Sizes = Required<Omit<PanelLayoutOptions, 'fixed' | 'wanted' | 'anchor' | 'moving' | 'spill'>>;

function places(grid: Grid, o: Sizes, scale: number, phase: Point) {
  const w = o.widthM * scale;
  const d = o.depthM * scale;
  const pitchX = w + o.gapM;
  const pitchY = d + o.rowGapM;
  const out: Point[] = [];
  for (let top = grid.maxY - phase[1]; top - d >= grid.minY - 1e-9; top -= pitchY) {
    const y0 = top - d;
    let ranges = grid.rings.flatMap((ring) => insideBand(ring, y0, top));
    for (const [fx, fy] of grid.fixed)
      if (fy + d / 2 + o.rowGapM > y0 && fy - d / 2 - o.rowGapM < top)
        ranges = subtract(ranges, [fx - w / 2 - o.gapM, fx + w / 2 + o.gapM]);
    // Left to right across every perimeter, so neighbouring places are neighbours in the row.
    for (const [a, b] of ranges.sort(([a0], [b0]) => a0 - b0)) {
      const first = Math.ceil((a - grid.minX - phase[0]) / pitchX - 1e-9);
      for (let k = first; ; k++) {
        const x = grid.minX + phase[0] + k * pitchX;
        if (x + w > b + 1e-9) break;
        out.push([x + w / 2, y0 + d / 2]);
      }
    }
  }
  return out;
}

/** The phase of the grid that holds the most panels at a scale. */
function roomiest(grid: Grid, o: Sizes, scale: number): Point[] {
  let best: Point[] = [];
  for (let i = 0; i < PHASES; i++)
    for (let j = 0; j < 2; j++) {
      const phase: Point = [((o.widthM * scale + o.gapM) * i) / PHASES, ((o.depthM * scale + o.rowGapM) * j) / 2];
      const found = places(grid, o, scale, phase);
      if (found.length > best.length) best = found;
    }
  return best;
}

/** The free places at a scale: in rows through the anchor's center when there is one, else the roomiest phase. */
function placesAt(grid: Grid, o: Sizes, scale: number, anchor: Point | undefined): Point[] {
  if (!anchor) return roomiest(grid, o, scale);
  const step = (value: number, size: number) => ((value % size) + size) % size;
  const [w, d] = [o.widthM * scale, o.depthM * scale];
  return places(grid, o, scale, [
    step(anchor[0] - w / 2 - grid.minX, w + o.gapM),
    step(grid.maxY - d / 2 - anchor[1], d + o.rowGapM),
  ]);
}

/** The free places in square cells, so the nearest one to a point is found among a few cells, not all of them. */
class PlaceIndex {
  readonly #cells = new Map<string, number[]>();
  readonly #size: number;

  constructor(
    readonly places: readonly Point[],
    cellM: number,
  ) {
    this.#size = Math.max(cellM, 1e-3);
    places.forEach(([x, y], i) => {
      const key = this.#key(Math.floor(x / this.#size), Math.floor(y / this.#size));
      const cell = this.#cells.get(key);
      if (cell) cell.push(i);
      else this.#cells.set(key, [i]);
    });
  }

  #key(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  /** The nearest place not in `taken`, by index, or -1: rings of cells outward until no nearer one can be left. */
  nearest([x, y]: Point, taken: ReadonlySet<number>): number {
    if (taken.size >= this.places.length) return -1;
    const cx = Math.floor(x / this.#size);
    const cy = Math.floor(y / this.#size);
    let best = -1;
    let bestD = Number.POSITIVE_INFINITY;
    for (let ring = 0; ; ring++) {
      for (let i = -ring; i <= ring; i++)
        for (let j = -ring; j <= ring; j++) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
          for (const index of this.#cells.get(this.#key(cx + i, cy + j)) ?? []) {
            if (taken.has(index)) continue;
            const [px, py] = this.places[index] as Point;
            const dist = (px - x) ** 2 + (py - y) ** 2;
            if (dist < bestD) [best, bestD] = [index, dist];
          }
        }
      // Every cell of the next ring lies at least `ring` cells away.
      if (best >= 0 && bestD <= (ring * this.#size) ** 2) return best;
      if (ring > this.#cells.size + 2) return best;
    }
  }
}

/**
 * Places `count` panels inside the perimeters (F658): at their size when there is room, else all shrunk alike, never
 * below `minScale`; panels that still find no place come back undefined, or line up outside with `spill` (F682).
 * Panels with a wanted position take the free place nearest to it, the others the free places in order: rows from
 * the far side of the bearing's left, each from the start of the row; `moving` panels push the others along (F681).
 */
export function layoutPanels(options: PanelLayoutOptions): PanelLayout {
  const o = {
    perimeters: options.perimeters,
    count: options.count,
    widthM: options.widthM,
    depthM: options.depthM,
    rowBearingDeg: options.rowBearingDeg ?? 90,
    gapM: options.gapM ?? 0.5,
    rowGapM: options.rowGapM ?? options.depthM,
    minScale: options.minScale ?? 0.85,
  };
  const frame = new Frame(o.perimeters.flat(), o.rowBearingDeg);
  const anchor = options.anchor && frame.toLocal(options.anchor);
  const rings = o.perimeters.map((ring) => ring.map((p) => frame.toLocal(p)));
  const all = rings.flat();
  const grid: Grid = {
    rings,
    fixed: (options.fixed ?? []).map((p) => frame.toLocal(p)),
    minX: Math.min(...all.map(([x]) => x)),
    maxX: Math.max(...all.map(([x]) => x)),
    minY: Math.min(...all.map(([, y]) => y)),
    maxY: Math.max(...all.map(([, y]) => y)),
  };
  let scale = 1;
  let free = placesAt(grid, o, scale, anchor);
  if (free.length < o.count) {
    let lo = o.minScale;
    let hi = 1;
    free = placesAt(grid, o, lo, anchor);
    scale = lo;
    for (let step = 0; step < SCALE_STEPS && free.length >= o.count; step++) {
      const mid = (lo + hi) / 2;
      const found = placesAt(grid, o, mid, anchor);
      if (found.length >= o.count) [lo, scale, free] = [mid, mid, found];
      else hi = mid;
    }
  }
  const centers = assign(free, o.count, options, (place) => frame.toLocal(place), (o.widthM + o.gapM) * scale).map(
    (place) => (place < 0 ? undefined : frame.toLonLat(free[place] as Point)),
  );
  if (options.spill) spill(centers, grid, o, scale, (point) => frame.toLonLat(point));
  return { centers, scale };
}

const NOTHING: ReadonlySet<number> = new Set();

/**
 * Each panel's place index, or -1: the panels not moving take the free place nearest their wanted position (else the
 * next free one, in order), then each moving one the place nearest its own, the panels in the way shifting along the
 * rows one place each toward the nearest free place (F681).
 */
function assign(
  free: readonly Point[],
  count: number,
  { wanted = [], moving = [] }: PanelLayoutOptions,
  toLocal: (p: LonLat) => Point,
  cellM: number,
): number[] {
  const index = new PlaceIndex(free, cellM);
  const holder = new Array<number>(free.length).fill(-1);
  const placeOf = new Array<number>(count).fill(-1);
  const taken = new Set<number>();
  const put = (panel: number, place: number): void => {
    holder[place] = panel;
    placeOf[panel] = place;
    taken.add(place);
  };
  const held = (place: number): boolean => (holder[place] ?? -1) >= 0;
  const makeRoom = (place: number): boolean => {
    let after = place;
    let before = place;
    while (after < free.length && held(after)) after++;
    while (before >= 0 && held(before)) before--;
    const forward = after < free.length && (before < 0 || after - place <= place - before);
    if (!forward && before < 0) return false;
    const step = forward ? -1 : 1;
    for (let at = forward ? after : before; at !== place; at += step) put(holder[at + step] ?? -1, at);
    return true;
  };
  let next = 0;
  const nextFree = (): number => {
    while (next < free.length && taken.has(next)) next++;
    return next < free.length ? next : -1;
  };
  const moved = new Set(moving);
  const order = [...Array(count).keys()]
    .filter((panel) => !moved.has(panel))
    .sort((a, b) => Number(wanted[b] !== undefined) - Number(wanted[a] !== undefined));
  for (const panel of order) {
    const want = wanted[panel];
    const place = want ? index.nearest(toLocal(want), taken) : nextFree();
    if (place >= 0) put(panel, place);
  }
  for (const panel of moving) {
    const want = wanted[panel];
    const place = want ? index.nearest(toLocal(want), NOTHING) : nextFree();
    if (place >= 0 && makeRoom(place)) put(panel, place);
  }
  return placeOf;
}

/** Panels without a place, in rows as wide as the perimeters, beyond the last row (F682). */
function spill(
  centers: (LonLat | undefined)[],
  grid: Grid,
  o: Sizes,
  scale: number,
  toLonLat: (point: Point) => LonLat,
): void {
  const w = o.widthM * scale;
  const d = o.depthM * scale;
  const perRow = Math.max(1, Math.floor((grid.maxX - grid.minX + o.gapM) / (w + o.gapM)));
  let k = 0;
  centers.forEach((center, panel) => {
    if (center) return;
    const x = grid.minX + w / 2 + (k % perRow) * (w + o.gapM);
    centers[panel] = toLonLat([x, grid.minY - o.rowGapM - d / 2 - Math.floor(k / perRow) * (d + o.rowGapM)]);
    k++;
  });
}
