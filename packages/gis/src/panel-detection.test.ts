import { describe, expect, it } from 'vitest';
import { detectPanels } from './panel-detection.js';
import type { LonLat } from './format.js';

const METERS_PER_DEGREE = 111_320;
const DEG = Math.PI / 180;
const SIDE_PX = 480;
const PIXEL_M = 0.25;
const SIDE_M = SIDE_PX * PIXEL_M;
const WEST = 13.9;
const NORTH = 52.5;
const PER_LONGITUDE = METERS_PER_DEGREE * Math.cos((NORTH - SIDE_M / METERS_PER_DEGREE / 2) * DEG);
const BOUNDS = {
  westDeg: WEST,
  eastDeg: WEST + SIDE_M / PER_LONGITUDE,
  northDeg: NORTH,
  southDeg: NORTH - SIDE_M / METERS_PER_DEGREE,
};
const TABLE = { widthM: 12, depthM: 4, gapM: 1, pitchM: 9 };

/** Meters east and north of the image's south-west corner as a position. */
const at = (x: number, y: number): LonLat => ({
  longitudeDeg: BOUNDS.westDeg + x / PER_LONGITUDE,
  latitudeDeg: BOUNDS.southDeg + y / METERS_PER_DEGREE,
});

/** Along and across rows of `bearing` around the image's center. */
function rowFrame(x: number, y: number, bearingDeg: number): [number, number] {
  const [dx, dy] = [x - SIDE_M / 2, y - SIDE_M / 2];
  const c = Math.cos(bearingDeg * DEG);
  const s = Math.sin(bearingDeg * DEG);
  return [dx * s + dy * c, dx * c - dy * s];
}

const mod = (value: number, by: number): number => ((value % by) + by) % by;

type ParkColors = {
  readonly table: readonly number[];
  readonly shadow: readonly number[];
  readonly ground: readonly number[];
};

const DARK_BLUE: ParkColors = { table: [42, 52, 78], shadow: [72, 60, 46], ground: [168, 156, 128] };

function pixelColor(colors: ParkColors, table: boolean, shadow: boolean, grass: boolean): readonly number[] {
  if (table) return colors.table;
  if (shadow) return colors.shadow;
  return grass ? [70, 110, 50] : colors.ground;
}

/** A park seen from above: dark bluish tables in rows of `bearing` on bare ground, with a patch of grass. */
function park(bearingDeg: number, shadowM = 0, colors = DARK_BLUE) {
  const data = new Uint8Array(SIDE_PX * SIDE_PX * 4);
  for (let row = 0; row < SIDE_PX; row++) {
    for (let column = 0; column < SIDE_PX; column++) {
      const x = (column + 0.5) * PIXEL_M;
      const y = SIDE_M - (row + 0.5) * PIXEL_M;
      const [u, v] = rowFrame(x, y, bearingDeg);
      const across = mod(v, TABLE.pitchM);
      const table = across < TABLE.depthM && mod(u, TABLE.widthM + TABLE.gapM) < TABLE.widthM;
      const shadow = across >= TABLE.depthM && across < TABLE.depthM + shadowM;
      const grass = x < 30 && y < 30;
      const [r = 0, g = 0, b = 0] = pixelColor(colors, table, shadow, grass);
      data.set([r, g, b, 255], (row * SIDE_PX + column) * 4);
    }
  }
  return { data, width: SIDE_PX, height: SIDE_PX };
}

/** The distance from a found center to the nearest real table's center, meters. */
function offset(center: LonLat, bearingDeg: number): number {
  const x = (center.longitudeDeg - BOUNDS.westDeg) * PER_LONGITUDE;
  const y = (center.latitudeDeg - BOUNDS.southDeg) * METERS_PER_DEGREE;
  const [u, v] = rowFrame(x, y, bearingDeg);
  const along = mod(u - TABLE.widthM / 2, TABLE.widthM + TABLE.gapM);
  const across = mod(v - TABLE.depthM / 2, TABLE.pitchM);
  return Math.hypot(Math.min(along, TABLE.widthM + TABLE.gapM - along), Math.min(across, TABLE.pitchM - across));
}

const PERIMETER = [at(15, 15), at(105, 15), at(105, 105), at(15, 105)];

describe('detectPanels (F664)', () => {
  it.each([90, 117, 15])('finds rows of bearing %d, their spacing, the tables and their centers', (bearing) => {
    const found = detectPanels({ image: park(bearing), bounds: BOUNDS, perimeters: [PERIMETER] });
    expect(found).toBeDefined();
    if (!found) return;
    expect(Math.abs(((found.rowBearingDeg - bearing + 270) % 180) - 90)).toBeLessThan(1);
    expect(found.depthM).toBeCloseTo(TABLE.depthM, 0);
    expect(found.rowPitchM).toBeCloseTo(TABLE.pitchM, 0);
    expect(Math.abs(found.widthM - TABLE.widthM)).toBeLessThan(1);
    // About ten rows of about seven tables in the 90 m square, cut tables at its edges included.
    expect(found.centers.length).toBeGreaterThan(50);
    expect(found.centers.length).toBeLessThan(90);
    const offsets = found.centers.map((center) => offset(center, bearing)).sort((a, b) => a - b);
    expect(offsets[Math.floor(offsets.length / 2)]).toBeLessThan(1);
  });

  it('leaves the warm shadows on the ground out of the rows', () => {
    const found = detectPanels({ image: park(90, 2.5), bounds: BOUNDS, perimeters: [PERIMETER] });
    expect(found?.depthM).toBeCloseTo(TABLE.depthM, 0);
  });

  it('finds light blue modules on grass darker than them, their grey shadows left out', () => {
    const colors = { table: [125, 142, 170], shadow: [54, 60, 71], ground: [96, 107, 100] } as const;
    const found = detectPanels({ image: park(90, 1, colors), bounds: BOUNDS, perimeters: [PERIMETER] });
    expect(found?.depthM).toBeCloseTo(TABLE.depthM, 0);
    expect(found?.rowPitchM).toBeCloseTo(TABLE.pitchM, 0);
  });

  it('finds black modules by their darkness when none is blue', () => {
    const colors = { table: [34, 34, 36], shadow: [72, 60, 46], ground: [168, 156, 128] } as const;
    const found = detectPanels({ image: park(90, 0, colors), bounds: BOUNDS, perimeters: [PERIMETER] });
    expect(found?.depthM).toBeCloseTo(TABLE.depthM, 0);
  });

  it('cuts continuous rows to the table length it is given', () => {
    const found = detectPanels({
      image: park(90),
      bounds: BOUNDS,
      perimeters: [PERIMETER],
      widthM: 6,
      gapM: 0.5,
    });
    expect(found?.widthM).toBe(6);
    expect(found?.centers.length).toBeGreaterThan(110);
  });

  it('takes a dark patch far deeper than a table, such as a wood, for no panels (KB-321)', () => {
    const data = new Uint8Array(SIDE_PX * SIDE_PX * 4);
    for (let row = 0; row < SIDE_PX; row++)
      for (let column = 0; column < SIDE_PX; column++) {
        const dark = row > 80 && row < 400 && column > 80 && column < 400;
        data.set([...(dark ? DARK_BLUE.table : DARK_BLUE.ground), 255], (row * SIDE_PX + column) * 4);
      }
    const image = { data, width: SIDE_PX, height: SIDE_PX };
    expect(detectPanels({ image, bounds: BOUNDS, perimeters: [PERIMETER] })).toBeUndefined();
  });

  it('finds nothing in bare ground', () => {
    const ground = new Uint8Array(SIDE_PX * SIDE_PX * 4).fill(150);
    expect(
      detectPanels({
        image: { data: ground, width: SIDE_PX, height: SIDE_PX },
        bounds: BOUNDS,
        perimeters: [PERIMETER],
      }),
    ).toBeUndefined();
  });
});
