import { describe, expect, it } from 'vitest';
import {
  buildingHeight,
  DEFAULT_BUILDING_HEIGHTS,
  extrudeBuilding,
  flatMapHeightScale,
  resolveBuildingParts,
  type BuildingFeature,
} from './buildings.js';
import { classifyRings, fillArea, tessellateFill, tileClipRect, type TileRing } from './fill-tessellate.js';
import { clipLine, tessellateLine, type LineGeometry, type LineOptions } from './line-tessellate.js';

/** A clockwise-on-screen (MVT exterior) rectangle ring. */
const rect = (x0: number, y0: number, x1: number, y1: number): TileRing => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];
const reversed = (ring: TileRing): TileRing => [...ring].reverse();

/** Sum of triangle areas of a line drawn `widthPx` wide (extrusion × width / 2). */
function lineArea(g: LineGeometry, width: number): number {
  let area = 0;
  const at = (i: number): [number, number] => [
    (g.positions[2 * i] ?? 0) + ((g.extrusions[2 * i] ?? 0) * width) / 2,
    (g.positions[2 * i + 1] ?? 0) + ((g.extrusions[2 * i + 1] ?? 0) * width) / 2,
  ];
  for (let i = 0; i < g.indices.length; i += 3) {
    const [a, b, c] = [at(g.indices[i] ?? 0), at(g.indices[i + 1] ?? 0), at(g.indices[i + 2] ?? 0)];
    area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  }
  return area;
}

const options = (join: LineOptions['join'], cap: LineOptions['cap']): LineOptions => ({
  join,
  cap,
  miterLimit: 2,
  roundSegments: 64,
});

describe('fill tessellation (F440, F443)', () => {
  it('groups exteriors with their holes and triangulates the area between them', () => {
    const rings = [rect(0, 0, 100, 100), reversed(rect(25, 25, 75, 75)), rect(200, 0, 300, 100)];
    expect(classifyRings(rings).map((p) => p.length)).toEqual([2, 1]);
    expect(fillArea(tessellateFill(rings, tileClipRect(4096, 128)))).toBeCloseTo(10000 - 2500 + 10000, 6);
  });

  it('meets the neighbouring tile at the tile edge with no gap and no overlap', () => {
    // A polygon across the vertical edge between two tiles of extent 100, in each tile's coordinates.
    const left = tessellateFill([rect(60, 10, 140, 90)], { minX: 0, minY: 0, maxX: 100, maxY: 100 });
    const right = tessellateFill([rect(-40, 10, 40, 90)], { minX: 0, minY: 0, maxX: 100, maxY: 100 });
    expect(fillArea(left) + fillArea(right)).toBeCloseTo(80 * 80, 6);
    const maxX = Math.max(...left.positions.filter((_, i) => i % 2 === 0));
    const minX = Math.min(...right.positions.filter((_, i) => i % 2 === 0));
    expect([maxX, minX]).toEqual([100, 0]);
  });
});

describe('line tessellation (F440, F450)', () => {
  const straight: TileRing = [
    [0, 0],
    [100, 0],
  ];
  const corner: TileRing = [
    [0, 0],
    [100, 0],
    [100, 100],
  ];

  it('builds caps as specified', () => {
    expect(lineArea(tessellateLine(straight, options('miter', 'butt')), 10)).toBeCloseTo(1000, 6);
    expect(lineArea(tessellateLine(straight, options('miter', 'square')), 10)).toBeCloseTo(1100, 6);
    expect(lineArea(tessellateLine(straight, options('miter', 'round')), 10)).toBeCloseTo(1000 + Math.PI * 25, 0);
  });

  it('fills the outer side of a turn with miter, bevel and round joins', () => {
    expect(lineArea(tessellateLine(corner, options('miter', 'butt')), 10)).toBeCloseTo(2025, 6);
    expect(lineArea(tessellateLine(corner, options('bevel', 'butt')), 10)).toBeCloseTo(2012.5, 6);
    expect(lineArea(tessellateLine(corner, options('round', 'butt')), 10)).toBeCloseTo(2000 + (Math.PI * 25) / 4, 1);
    const sharp: TileRing = [
      [0, 0],
      [100, 0],
      [0, 10],
    ];
    const miter = lineArea(tessellateLine(sharp, options('miter', 'butt')), 10);
    const bevel = lineArea(tessellateLine(sharp, options('bevel', 'butt')), 10);
    expect(miter).toBeCloseTo(bevel, 6);
  });

  it('keeps the width out of the geometry, so any width is a paint value', () => {
    const g = tessellateLine(corner, options('miter', 'round'));
    for (const w of [10, 20, 3.5]) {
      expect(lineArea(g, w)).toBeCloseTo(200 * w + (w / 2) ** 2 + (Math.PI * w * w) / 4, 0);
    }
    expect(Math.max(...g.distances)).toBeCloseTo(200, 4);
  });

  it('splits lines at the clip rectangle and adds no cap at a clipped end', () => {
    const clip = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const parts = clipLine(
      [
        [50, 50],
        [150, 50],
        [150, 60],
        [50, 60],
      ],
      clip,
    );
    expect(parts).toEqual([
      [
        [50, 50],
        [100, 50],
      ],
      [
        [100, 60],
        [50, 60],
      ],
    ]);
    const part = parts[0] ?? [];
    const capped = lineArea(tessellateLine(part, options('miter', 'square')), 10);
    const clipped = lineArea(tessellateLine(part, options('miter', 'square'), clip), 10);
    expect(capped - clipped).toBeCloseTo(50, 6);
  });
});

describe('building heights (F455, F456)', () => {
  it('reads height, min_height, building:levels and render_height', () => {
    expect(buildingHeight({ building: 'yes', height: '24.5' })).toEqual({
      baseMeters: 0,
      heightMeters: 24.5,
      source: 'height',
    });
    expect(buildingHeight({ building: 'yes', 'building:levels': 7 }).heightMeters).toBe(21);
    expect(buildingHeight({ height: 30, min_height: 12 })).toMatchObject({ baseMeters: 12, heightMeters: 30 });
    expect(buildingHeight({ 'building:levels': '5', 'building:min_level': '2' })).toMatchObject({
      baseMeters: 6,
      heightMeters: 15,
    });
    expect(buildingHeight({ render_height: 40, render_min_height: 10 })).toMatchObject({
      baseMeters: 10,
      heightMeters: 40,
    });
    expect(buildingHeight({ height: '100 ft' }).heightMeters).toBeCloseTo(30.48, 6);
  });

  it('gives untagged buildings the documented default by type, identical in every tile', () => {
    for (const type of ['house', 'apartments', 'commercial', 'industrial', 'church', 'garage']) {
      expect(buildingHeight({ building: type })).toEqual({
        baseMeters: 0,
        heightMeters: DEFAULT_BUILDING_HEIGHTS[type],
        source: 'default',
      });
    }
    expect(buildingHeight({ building: 'unheard-of' }).heightMeters).toBe(DEFAULT_BUILDING_HEIGHTS['yes']);
  });

  it('lets building parts replace their outline', () => {
    const outline: BuildingFeature = { id: 1, rings: [rect(0, 0, 100, 100)], properties: { building: 'yes' } };
    const tower: BuildingFeature = {
      id: 2,
      rings: [rect(10, 10, 40, 40)],
      properties: { 'building:part': 'yes', height: 60 },
    };
    const podium: BuildingFeature = {
      id: 3,
      rings: [rect(40, 10, 90, 90)],
      properties: { 'building:part': 'yes', height: 10 },
    };
    const other: BuildingFeature = { id: 4, rings: [rect(200, 0, 300, 100)], properties: { building: 'house' } };
    const hidden: BuildingFeature = { id: 5, rings: [rect(400, 0, 500, 100)], properties: { hide_3d: true } };
    expect(resolveBuildingParts([outline, tower, podium, other, hidden]).map((f) => f.id)).toEqual([2, 3, 4]);
  });
});

describe('extrusion geometry (F455, F457, F458)', () => {
  const clip = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

  it('builds walls with outward normals between base and top, and a roof', () => {
    const g = extrudeBuilding([rect(10, 10, 30, 30)], { baseMeters: 5, heightMeters: 20, source: 'height' }, clip);
    const zs = new Set(Array.from(g.positions).filter((_, i) => i % 3 === 2));
    expect([...zs].sort((a, b) => a - b)).toEqual([5, 20]);
    const wallNormals = new Set<string>();
    for (let i = 0; i < g.normals.length; i += 3) {
      if (g.normals[i + 2] === 0) wallNormals.add(`${g.normals[i]},${g.normals[i + 1]}`);
    }
    expect([...wallNormals].sort()).toEqual(['-1,0', '0,-1', '0,1', '1,0'].sort());
    // Normal of the wall along y = 10 (the north side on screen) points north (negative y).
    const north = Array.from({ length: g.normals.length / 3 }, (_, i) => i).find(
      (i) => g.positions[3 * i + 1] === 10 && g.positions[3 * (i + 1) + 1] === 10 && g.normals[3 * i + 2] === 0,
    );
    expect(g.normals[3 * (north ?? 0) + 1]).toBe(-1);
    expect(g.indices.length).toBe(4 * 6 + 6);
  });

  it('builds no wall along the tile edge where a building continues in the next tile', () => {
    const g = extrudeBuilding([rect(60, 10, 140, 90)], { baseMeters: 0, heightMeters: 10, source: 'height' }, clip);
    expect(g.indices.length).toBe(3 * 6 + 6);
  });

  it('scales heights on the flat map by the Mercator scale factor', () => {
    expect(flatMapHeightScale(0)).toBe(1);
    expect(flatMapHeightScale(45)).toBeCloseTo(Math.SQRT2, 12);
    expect(flatMapHeightScale(60)).toBeCloseTo(2, 12);
  });
});
