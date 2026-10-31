// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Finds the rows of solar tables in a top-down image of an area (F664), with plain image arithmetic and no trained
 * model: the blue pixels are the panels (or, for black modules, the pixels darker than the ground; green and warm
 * tones never), the direction along which their projection piles into the sharpest stripes is the rows' bearing, the
 * stripes are the rows, and the runs of panel along each row are its tables, cut to a table's length.
 */
import type { LonLat } from './format.js';

const METERS_PER_DEGREE = 111_320;
const DEG = Math.PI / 180;
/** Profile bins, meters: stripes for the bearing, then rows and tables. */
const BEARING_BIN_M = 0.5;
const BIN_M = 0.25;
/** The bearing search: coarse steps over half a turn, then a finer pass around the best. */
const COARSE_STEP_DEG = 2;
const FINE_STEP_DEG = 0.25;
/** Panel pixels the bearing search projects at most: more are sampled evenly. */
const BEARING_POINTS = 40_000;
/** A bin belongs to a row or a table when this share of its pixels is panel. */
const FILLED = 0.45;
/** Rows and tables shorter than this are noise, meters. */
const MIN_ROW_M = 1;
const MIN_TABLE_M = 1.5;
/** Single tables are told from continuous rows by length: between these, meters. */
const TABLE_LENGTH_M: readonly [number, number] = [2, 30];
/** Below or above these shares of the area, panels cannot be told from the ground. */
const MIN_PANEL_SHARE = 0.03;
const MAX_PANEL_SHARE = 0.97;
const OTSU_BINS = 64;
/** Red over blue by more than this, a pixel is warm: soil, dry grass, roofs and the shadows on them. */
const WARM = 12;
/** Blue over the mean of red and green by this much at least, a pixel is a panel's: light and dark modules alike. */
const BLUE_EXCESS = 18;

/** An RGBA image, rows from the top: a capture of the view, north up and looking straight down. */
export interface PanelImage {
  readonly data: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
}

/** Options of {@link detectPanels}. */
export interface PanelDetectionOptions {
  readonly image: PanelImage;
  /** The image's edges, degrees: west and east at its left and right, north and south at its top and bottom. */
  readonly bounds: {
    readonly westDeg: number;
    readonly eastDeg: number;
    readonly southDeg: number;
    readonly northDeg: number;
  };
  /** The areas to look in: each an outer ring of positions. */
  readonly perimeters: readonly (readonly LonLat[])[];
  /** A table's length along its row, meters, when known: otherwise the length of the lone tables seen. */
  readonly widthM?: number;
  /** Space between tables in a row, meters (default 0.5). */
  readonly gapM?: number;
}

/** What {@link detectPanels} found: the rows' bearing and spacing, a table's size, and every table's center. */
export interface DetectedPanels {
  /** The rows' compass bearing, degrees in [0, 180). */
  readonly rowBearingDeg: number;
  readonly widthM: number;
  readonly depthM: number;
  /** From one row's center to the next, meters. */
  readonly rowPitchM: number;
  readonly centers: readonly LonLat[];
}

interface Frame {
  readonly width: number;
  readonly height: number;
  /** Meters per pixel eastward and southward. */
  readonly mx: number;
  readonly my: number;
}

/** Finds the tables in `image` inside the perimeters; undefined when no rows stand out from the ground. */
export function detectPanels(options: PanelDetectionOptions): DetectedPanels | undefined {
  const { image, bounds } = options;
  const midLatitude = ((bounds.northDeg + bounds.southDeg) / 2) * DEG;
  const frame: Frame = {
    width: image.width,
    height: image.height,
    mx: ((bounds.eastDeg - bounds.westDeg) * METERS_PER_DEGREE * Math.cos(midLatitude)) / image.width,
    my: ((bounds.northDeg - bounds.southDeg) * METERS_PER_DEGREE) / image.height,
  };
  const toPixel = (p: LonLat): [number, number] => [
    ((p.longitudeDeg - bounds.westDeg) / (bounds.eastDeg - bounds.westDeg)) * image.width,
    ((bounds.northDeg - p.latitudeDeg) / (bounds.northDeg - bounds.southDeg)) * image.height,
  ];
  const mask = polygonMask(
    options.perimeters.map((ring) => ring.map(toPixel)),
    image.width,
    image.height,
  );
  const panel = panelPixels(image, mask);
  if (!panel) return undefined;
  const area = areaOf(mask, panel, frame);
  const bearing = bestBearing(area);
  const [u, v] = rotateAll(area, bearing);
  const rows = filledRuns(v, area.panel, indices(v.length), MIN_ROW_M);
  if (!rows.length) return undefined;
  const gapM = options.gapM ?? 0.5;
  const tables = membersByRow(v, rows).map((members) => filledRuns(u, area.panel, members, MIN_TABLE_M));
  const widthM = options.widthM ?? loneTableLength(tables.flat()) ?? TABLE_LENGTH_M[1];
  const centers: LonLat[] = [];
  rows.forEach((row, index) => {
    for (const [u0, u1] of tables[index] ?? []) {
      for (const u of tablesAlong(u0, u1, widthM, gapM)) {
        const [x, y] = unrotate(u, (row[0] + row[1]) / 2, bearing);
        const column = x / frame.mx;
        const line = frame.height - y / frame.my;
        if (mask[Math.floor(line) * frame.width + Math.floor(column)])
          centers.push({
            longitudeDeg: bounds.westDeg + (column / frame.width) * (bounds.eastDeg - bounds.westDeg),
            latitudeDeg: bounds.northDeg - (line / frame.height) * (bounds.northDeg - bounds.southDeg),
          });
      }
    }
  });
  const depths = rows.map(([v0, v1]) => v1 - v0);
  const middles = rows.map(([v0, v1]) => (v0 + v1) / 2);
  const pitches = middles.slice(1).map((v, k) => v - (middles[k] ?? v));
  const depthM = median(depths) ?? 0;
  return {
    rowBearingDeg: ((bearing % 180) + 180) % 180,
    widthM,
    depthM,
    rowPitchM: median(pitches) ?? depthM * 2,
    centers,
  };
}

/** 1 for the pixels inside any ring (even–odd per ring), by scanline. */
function polygonMask(rings: readonly (readonly [number, number][])[], width: number, height: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    const y = row + 0.5;
    for (const ring of rings) {
      const crossings: number[] = [];
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i] as [number, number];
        const [x2, y2] = ring[(i + 1) % ring.length] as [number, number];
        if (y1 <= y !== y2 <= y) crossings.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
      crossings.sort((a, b) => a - b);
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const from = Math.max(0, Math.ceil((crossings[k] ?? 0) - 0.5));
        const to = Math.min(width - 1, Math.floor((crossings[k + 1] ?? 0) - 0.5));
        for (let column = from; column <= to; column++) mask[row * width + column] = 1;
      }
    }
  }
  return mask;
}

/** A pixel's color: red, green, blue, and how far its blue stands over the mean of the other two. */
function colorAt(data: ArrayLike<number>, index: number): { r: number; g: number; b: number; blueExcess: number } {
  const r = data[index * 4] ?? 0;
  const g = data[index * 4 + 1] ?? 0;
  const b = data[index * 4 + 2] ?? 0;
  return { r, g, b, blueExcess: b - (r + g) / 2 };
}

/** Vegetation is green, bare ground and the shadows on it warm: neither is a panel. */
const isGround = (r: number, g: number, b: number): boolean => (g > r + 10 && g > b + 5) || r > b + WARM;

/**
 * 1 for the panel pixels of the masked area. Panels are blue, light or dark: the pixels whose blue stands over red and
 * green by {@link BLUE_EXCESS} at least. Black panels are not: when too few pixels are blue, the pixels darker than
 * Otsu's threshold of the area's tones are. Green and warm pixels never count. Undefined when panels and ground cannot
 * be told apart.
 */
function panelPixels(image: PanelImage, mask: Uint8Array): Uint8Array | undefined {
  const blue = selectPixels(image, mask, (color) => color.blueExcess >= BLUE_EXCESS);
  if (blue) return blue;
  const histogram = new Float64Array(OTSU_BINS);
  let inside = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const { r, g, b } = colorAt(image.data, i);
    // Ground counts as the lightest tone, so the split falls between the panels and everything else.
    const tone = isGround(r, g, b) ? 255 : 0.299 * r + 0.587 * g + 0.114 * b;
    const bin = Math.min(OTSU_BINS - 1, Math.floor((tone / 256) * OTSU_BINS));
    histogram[bin] = (histogram[bin] ?? 0) + 1;
    inside++;
  }
  if (!inside) return undefined;
  const threshold = ((otsu(histogram, inside) + 1) / OTSU_BINS) * 256;
  return selectPixels(image, mask, ({ r, g, b }) => 0.299 * r + 0.587 * g + 0.114 * b < threshold);
}

/** 1 for the masked pixels, not ground, that `accept` takes; undefined when they are too few or too many. */
function selectPixels(
  image: PanelImage,
  mask: Uint8Array,
  accept: (color: ReturnType<typeof colorAt>) => boolean,
): Uint8Array | undefined {
  const panel = new Uint8Array(mask.length);
  let inside = 0;
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    inside++;
    const color = colorAt(image.data, i);
    if (isGround(color.r, color.g, color.b) || !accept(color)) continue;
    panel[i] = 1;
    count++;
  }
  const share = inside ? count / inside : 0;
  return share >= MIN_PANEL_SHARE && share <= MAX_PANEL_SHARE ? panel : undefined;
}

/** The histogram bin that best splits it in two classes (Otsu's between-class variance). */
function otsu(histogram: Float64Array, total: number): number {
  let sum = 0;
  for (let k = 0; k < histogram.length; k++) sum += k * (histogram[k] ?? 0);
  let below = 0;
  let sumBelow = 0;
  let best = 0;
  let split = 0;
  for (let k = 0; k < histogram.length; k++) {
    below += histogram[k] ?? 0;
    if (!below || below === total) continue;
    sumBelow += k * (histogram[k] ?? 0);
    const meanBelow = sumBelow / below;
    const meanAbove = (sum - sumBelow) / (total - below);
    const variance = below * (total - below) * (meanBelow - meanAbove) ** 2;
    if (variance > best) {
      best = variance;
      split = k;
    }
  }
  return split;
}

/** The pixels of the area: meters east and north of the image's south-west corner, and whether each is panel. */
interface Area {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly panel: Uint8Array;
}

function areaOf(mask: Uint8Array, panel: Uint8Array, frame: Frame): Area {
  let count = 0;
  for (const value of mask) count += value;
  const area = { x: new Float64Array(count), y: new Float64Array(count), panel: new Uint8Array(count) };
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    area.x[n] = ((i % frame.width) + 0.5) * frame.mx;
    area.y[n] = (frame.height - Math.floor(i / frame.width) - 0.5) * frame.my;
    area.panel[n++] = panel[i] ?? 0;
  }
  return area;
}

/**
 * The bearing across which the panel pixels pile into the sharpest stripes, where the sum of the squared counts of
 * their projections' bins is largest; a bounded sample of them is projected.
 */
function bestBearing(area: Area): number {
  const chosen: number[] = [];
  let extent = 0;
  for (let k = 0; k < area.panel.length; k++)
    if (area.panel[k]) {
      chosen.push(k);
      extent = Math.max(extent, Math.hypot(area.x[k] ?? 0, area.y[k] ?? 0));
    }
  const stride = Math.max(1, Math.ceil(chosen.length / BEARING_POINTS));
  const sample = chosen.filter((_, k) => k % stride === 0);
  const counts = new Int32Array(Math.ceil((2 * extent) / BEARING_BIN_M) + 2);
  const sharpness = (bearingDeg: number): number => {
    const c = Math.cos(bearingDeg * DEG);
    const s = Math.sin(bearingDeg * DEG);
    counts.fill(0);
    for (const k of sample) {
      const bin = Math.floor(((area.x[k] ?? 0) * c - (area.y[k] ?? 0) * s + extent) / BEARING_BIN_M);
      counts[bin] = (counts[bin] ?? 0) + 1;
    }
    let total = 0;
    for (const count of counts) total += count * count;
    return total;
  };
  const search = (from: number, to: number, step: number, best: [number, number]): [number, number] => {
    for (let bearing = from; bearing < to; bearing += step) {
      const value = sharpness(bearing);
      if (value > best[1]) best = [bearing, value];
    }
    return best;
  };
  const [coarse] = search(0, 180, COARSE_STEP_DEG, [0, -1]);
  return search(coarse - COARSE_STEP_DEG, coarse + COARSE_STEP_DEG, FINE_STEP_DEG, [coarse, sharpness(coarse)])[0];
}

/** Every pixel's coordinates along (u) and across (v) rows of `bearing`. */
function rotateAll(area: Area, bearingDeg: number): [Float64Array, Float64Array] {
  const c = Math.cos(bearingDeg * DEG);
  const s = Math.sin(bearingDeg * DEG);
  const u = new Float64Array(area.x.length);
  const v = new Float64Array(area.x.length);
  for (let k = 0; k < u.length; k++) {
    const x = area.x[k] ?? 0;
    const y = area.y[k] ?? 0;
    u[k] = x * s + y * c;
    v[k] = x * c - y * s;
  }
  return [u, v];
}

/** Meters east and north of a point along (u) and across (v) rows of `bearing`. */
function unrotate(u: number, v: number, bearingDeg: number): [number, number] {
  const c = Math.cos(bearingDeg * DEG);
  const s = Math.sin(bearingDeg * DEG);
  return [u * s + v * c, u * c - v * s];
}

const indices = (count: number): Int32Array => Int32Array.from({ length: count }, (_, k) => k);

/** The pixels of each row: those whose coordinate across the rows falls in its run. */
function membersByRow(v: Float64Array, rows: readonly [number, number][]): number[][] {
  const members: number[][] = rows.map(() => []);
  for (let k = 0; k < v.length; k++) {
    const across = v[k] ?? 0;
    let low = 0;
    let high = rows.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const [from, to] = rows[middle] as [number, number];
      if (across < from) high = middle - 1;
      else if (across >= to) low = middle + 1;
      else {
        members[middle]?.push(k);
        break;
      }
    }
  }
  return members;
}

/**
 * The runs of filled bins of the profile of `coordinate` over the `members` pixels: a bin is filled when, with its
 * neighbours, at least {@link FILLED} of its pixels are panel. Runs shorter than `minM` are dropped.
 */
function filledRuns(
  coordinate: Float64Array,
  panel: Uint8Array,
  members: ArrayLike<number>,
  minM: number,
): [number, number][] {
  if (!members.length) return [];
  let low = Number.POSITIVE_INFINITY;
  for (let k = 0; k < members.length; k++) low = Math.min(low, coordinate[members[k] ?? 0] ?? 0);
  const origin = Math.floor(low / BIN_M);
  const all: number[] = [];
  const filled: number[] = [];
  for (let k = 0; k < members.length; k++) {
    const index = members[k] ?? 0;
    const bin = Math.floor((coordinate[index] ?? 0) / BIN_M) - origin;
    all[bin] = (all[bin] ?? 0) + 1;
    filled[bin] = (filled[bin] ?? 0) + (panel[index] ?? 0);
  }
  const share = (bin: number): number => (all[bin] ? (filled[bin] ?? 0) / (all[bin] ?? 1) : 0);
  const runs: [number, number][] = [];
  let start: number | undefined;
  for (let bin = 0; bin <= all.length; bin++) {
    const isFilled = !!all[bin] && (share(bin - 1) + share(bin) + share(bin + 1)) / 3 >= FILLED;
    if (isFilled) start ??= bin;
    else if (start !== undefined) {
      runs.push([(start + origin) * BIN_M, (bin + origin) * BIN_M]);
      start = undefined;
    }
  }
  return runs.filter(([from, to]) => to - from >= minM);
}

/** The length of the lone tables: the median of the runs that are a table long rather than a continuous row. */
function loneTableLength(runs: readonly [number, number][]): number | undefined {
  return median(
    runs.map(([from, to]) => to - from).filter((length) => length >= TABLE_LENGTH_M[0] && length <= TABLE_LENGTH_M[1]),
  );
}

/** The centers of the tables of `widthM` that fit a run, `gapM` apart and centered in it; one at least. */
function tablesAlong(u0: number, u1: number, widthM: number, gapM: number): number[] {
  const count = Math.max(1, Math.round((u1 - u0 + gapM) / (widthM + gapM)));
  const first = (u0 + u1) / 2 - ((count - 1) * (widthM + gapM)) / 2;
  return Array.from({ length: count }, (_, k) => first + k * (widthM + gapM));
}

function median(values: readonly number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
