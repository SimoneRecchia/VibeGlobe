/**
 * The generated fixture city of the 3D Tiles tests and of the playground's `3dtiles-city` scenario (F461–F467, F471):
 * a 1,024 m square at the Colosseum in Rome, far from the ECEF origin, as a REPLACE quadtree of four levels (1, 4, 16
 * and 64 tiles). Every tile covers its square with a ground plate 1 m above the ellipsoid and the buildings of its
 * area: the 64 leaves draw each of the 1,024 buildings (20 m footprints on a 32 m grid, 8–60 m tall), coarser levels
 * merge them into blocks with the tallest height. Levels 0 and 1 are 3D Tiles 1.0 `b3dm` with batch tables; levels 2
 * and 3 are 1.1 `glb` with `EXT_mesh_features` and an `EXT_structural_metadata` property table. Variants compress the
 * geometry with Draco or meshopt, or texture the ground with KTX2. Test code only.
 */
import { fixtureHeightMeters } from '../../../scripts/fixtures/tiles/terrain.ts';
import { writeGlb, type Compression, type PrimitiveData } from './glb-writer.ts';

/** The city's center. */
export const CITY_CENTER = { longitudeDeg: 12.4922, latitudeDeg: 41.8902, heightMeters: 0 } as const;
/** Side of the city square, in meters. */
export const CITY_SIZE_METERS = 1024;
/** Levels of the quadtree. */
export const CITY_LEVELS = 4;
const CELL = 32;
const FOOTPRINT = 20;
const GROUND_HEIGHT = 1;
/** The copyright every content declares (F470's copyright list). */
export const CITY_COPYRIGHT = 'VibeGlobe fixture city';

/** Fixture variants. */
export type CityVariant = 'plain' | 'draco' | 'meshopt' | 'ktx2' | 'terrain';

/**
 * The ground's height under a point of the city (meters east and north of its center): the plate 1 m above the
 * ellipsoid, or for the `terrain` variant the fixture server's analytic terrain (F467), which the ground then follows.
 */
type GroundHeight = (east: number, north: number) => number;
const flatGround: GroundHeight = () => GROUND_HEIGHT;
const terrainGround: GroundHeight = (east, north) => {
  const lat = (CITY_CENTER.latitudeDeg + north / 110_950) * (Math.PI / 180);
  const lon = (CITY_CENTER.longitudeDeg + east / (111_320 * Math.cos(lat))) * (Math.PI / 180);
  return fixtureHeightMeters(lon, lat);
};

/** The deterministic height of the building in grid cell (i, j), in meters. */
export function buildingHeight(i: number, j: number): number {
  const h = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453;
  return 8 + Math.round((h - Math.floor(h)) * 52);
}

/** The name of the building in grid cell (i, j). */
export const buildingName = (i: number, j: number): string => `building-${i}-${j}`;

/** The ENU-to-ECEF transform at the city center, column-major (the root tile's `transform`). */
export function cityTransform(): number[] {
  const lon = (CITY_CENTER.longitudeDeg * Math.PI) / 180;
  const lat = (CITY_CENTER.latitudeDeg * Math.PI) / 180;
  const a = 6378137;
  const e2 = 6.69437999014e-3;
  const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  const p = [n * Math.cos(lat) * Math.cos(lon), n * Math.cos(lat) * Math.sin(lon), n * (1 - e2) * Math.sin(lat)];
  const east = [-Math.sin(lon), Math.cos(lon), 0];
  const north = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
  const up = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  return [...east, 0, ...north, 0, ...up, 0, ...p, 1];
}

interface Feature {
  readonly name: string;
  readonly height: number;
}

/** Geometry being built, in glTF axes: +X east, +Y up, +Z south. */
class Shapes {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];
  readonly ids: number[] = [];
  readonly indices: number[] = [];

  /** A quad from four corners (counter-clockwise seen from the normal's side). */
  quad(corners: readonly (readonly number[])[], normal: readonly number[], id: number, uv?: readonly number[][]): void {
    const base = this.positions.length / 3;
    corners.forEach((c, k) => {
      this.positions.push(...c);
      this.normals.push(...normal);
      this.ids.push(id);
      this.uvs.push(...(uv?.[k] ?? [0, 0]));
    });
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** A box from `base` up to `height`, centered at (east, north) with a square footprint. */
  box(east: number, north: number, half: number, base: number, height: number, id: number): void {
    const x0 = east - half;
    const x1 = east + half;
    const z0 = -(north + half);
    const z1 = -(north - half);
    const y0 = base;
    const y1 = height;
    this.quad(
      [
        [x0, y1, z1],
        [x1, y1, z1],
        [x1, y1, z0],
        [x0, y1, z0],
      ],
      [0, 1, 0],
      id,
    );
    this.quad(
      [
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
      ],
      [0, 0, 1],
      id,
    );
    this.quad(
      [
        [x1, y0, z0],
        [x0, y0, z0],
        [x0, y1, z0],
        [x1, y1, z0],
      ],
      [0, 0, -1],
      id,
    );
    this.quad(
      [
        [x1, y0, z1],
        [x1, y0, z0],
        [x1, y1, z0],
        [x1, y1, z1],
      ],
      [1, 0, 0],
      id,
    );
    this.quad(
      [
        [x0, y0, z0],
        [x0, y0, z1],
        [x0, y1, z1],
        [x0, y1, z0],
      ],
      [-1, 0, 0],
      id,
    );
  }

  data(color: PrimitiveData['color'], image?: PrimitiveData['image']): PrimitiveData {
    return {
      positions: Float32Array.from(this.positions),
      normals: Float32Array.from(this.normals),
      ...(image ? { uvs: Float32Array.from(this.uvs) } : {}),
      featureIds: Float32Array.from(this.ids),
      indices: Uint16Array.from(this.indices),
      color,
      ...(image ? { image } : {}),
    };
  }
}

/** The buildings or blocks of a tile and their geometry. */
function tileShapes(level: number, x: number, y: number, ground: GroundHeight, image?: PrimitiveData['image']) {
  const size = CITY_SIZE_METERS / 2 ** level;
  const west = -CITY_SIZE_METERS / 2 + x * size;
  const south = -CITY_SIZE_METERS / 2 + y * size;
  const block = CELL * 2 ** (CITY_LEVELS - 1 - level);
  const perSide = size / block;
  const features: Feature[] = [];
  const buildings = new Shapes();
  for (let bi = 0; bi < perSide; bi++)
    for (let bj = 0; bj < perSide; bj++) {
      const cells = block / CELL;
      const i0 = Math.round((west + CITY_SIZE_METERS / 2) / CELL) + bi * cells;
      const j0 = Math.round((south + CITY_SIZE_METERS / 2) / CELL) + bj * cells;
      let height = 0;
      for (let i = i0; i < i0 + cells; i++)
        for (let j = j0; j < j0 + cells; j++) height = Math.max(height, buildingHeight(i, j));
      const name = cells === 1 ? buildingName(i0, j0) : `block-${level}-${i0}-${j0}`;
      const half = (block - (CELL - FOOTPRINT)) / 2;
      const east = west + (bi + 0.5) * block;
      const north = south + (bj + 0.5) * block;
      // On flat ground the roof is at the building's height; on terrain, that far above the ground at its center.
      const base = ground(east, north);
      const roof = ground === flatGround ? height : base + height;
      buildings.box(east, north, half, ground === flatGround ? GROUND_HEIGHT : base - 2, roof, features.length);
      features.push({ name, height });
    }
  const plate = new Shapes();
  // The ground: one quad on flat ground; a grid following the terrain, 8 cells a side.
  const cellsPerSide = ground === flatGround ? 1 : 8;
  const cell = size / cellsPerSide;
  for (let ci = 0; ci < cellsPerSide; ci++)
    for (let cj = 0; cj < cellsPerSide; cj++) {
      const [e0, e1, n0, n1] = [west + ci * cell, west + (ci + 1) * cell, south + cj * cell, south + (cj + 1) * cell];
      const u = (e: number) => (e - west) / size;
      const v = (n: number) => 1 - (n - south) / size;
      plate.quad(
        [
          [e0, ground(e0, n0), -n0],
          [e1, ground(e1, n0), -n0],
          [e1, ground(e1, n1), -n1],
          [e0, ground(e0, n1), -n1],
        ],
        [0, 1, 0],
        features.length,
        [
          [u(e0), v(n0)],
          [u(e1), v(n0)],
          [u(e1), v(n1)],
          [u(e0), v(n1)],
        ],
      );
    }
  features.push({ name: 'ground', height: GROUND_HEIGHT });
  return {
    features,
    primitives: [
      buildings.data([0.86, 0.74, 0.58, 1]),
      // On terrain the ground is purple, so terrain or imagery showing through it stands out (F467).
      plate.data(ground === flatGround ? [0.5, 0.56, 0.46, 1] : [0.55, 0.3, 0.62, 1], image),
    ],
  };
}

const encoder = new TextEncoder();
const pad8 = (n: number): number => (n + 7) & ~7;

function paddedJson(value: unknown, start: number): Uint8Array {
  const text = JSON.stringify(value);
  return encoder.encode(text.padEnd(pad8(start + text.length) - start, ' '));
}

/** A `b3dm` around a GLB with a batch table of the features. */
function b3dm(glb: Uint8Array, features: readonly Feature[]): Uint8Array {
  const featureTable = paddedJson({ BATCH_LENGTH: features.length }, 28);
  const batchTable = paddedJson(
    { name: features.map((f) => f.name), height: features.map((f) => f.height) },
    28 + featureTable.length,
  );
  const total = 28 + featureTable.length + batchTable.length + glb.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out.set(encoder.encode('b3dm'), 0);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, featureTable.length, true);
  dv.setUint32(20, batchTable.length, true);
  out.set(featureTable, 28);
  out.set(batchTable, 28 + featureTable.length);
  out.set(glb, 28 + featureTable.length + batchTable.length);
  return out;
}

const SCHEMA = {
  id: 'city',
  classes: {
    building: { properties: { name: { type: 'STRING' }, height: { type: 'SCALAR', componentType: 'FLOAT32' } } },
  },
};

/** The property table of the features, writing its buffer views with `view`. */
function propertyTable(features: readonly Feature[], view: (bytes: Uint8Array) => number): unknown {
  const names = features.map((f) => encoder.encode(f.name));
  const offsets = new Uint32Array(names.length + 1);
  names.forEach((n, i) => (offsets[i + 1] = (offsets[i] ?? 0) + n.length));
  const strings = new Uint8Array(offsets[names.length] ?? 0);
  names.forEach((n, i) => strings.set(n, offsets[i] ?? 0));
  const heights = Float32Array.from(features.map((f) => f.height));
  return {
    class: 'building',
    count: features.length,
    properties: {
      name: { values: view(strings), stringOffsets: view(new Uint8Array(offsets.buffer)), stringOffsetType: 'UINT32' },
      height: { values: view(new Uint8Array(heights.buffer)) },
    },
  };
}

function tileJson(level: number, x: number, y: number, bottom: number, top: number): Record<string, unknown> {
  const size = CITY_SIZE_METERS / 2 ** level;
  const cx = -CITY_SIZE_METERS / 2 + (x + 0.5) * size;
  const cy = -CITY_SIZE_METERS / 2 + (y + 0.5) * size;
  const leaf = level === CITY_LEVELS - 1;
  const children: Record<string, unknown>[] = [];
  if (!leaf)
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const)
      children.push(tileJson(level + 1, 2 * x + dx, 2 * y + dy, bottom, top));
  return {
    boundingVolume: { box: [cx, cy, (bottom + top) / 2, size / 2, 0, 0, 0, size / 2, 0, 0, 0, (top - bottom) / 2] },
    geometricError: leaf ? 0 : 64 / 2 ** level,
    refine: 'REPLACE',
    content: { uri: `tiles/${level}/${x}/${y}.${level < 2 ? 'b3dm' : 'glb'}` },
    ...(children.length > 0 ? { children } : {}),
  };
}

/** Every file of a variant of the city by its path relative to the tileset: `tileset.json` and the tiles. */
export async function cityFiles(variant: CityVariant, ktx2Image?: Uint8Array): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  const ground = variant === 'terrain' ? terrainGround : flatGround;
  let bottom = Infinity;
  let top = -Infinity;
  for (let e = -CITY_SIZE_METERS / 2; e <= CITY_SIZE_METERS / 2; e += 16)
    for (let n = -CITY_SIZE_METERS / 2; n <= CITY_SIZE_METERS / 2; n += 16) {
      bottom = Math.min(bottom, ground(e, n) - 2);
      top = Math.max(top, ground(e, n) + 62);
    }
  if (ground === flatGround) [bottom, top] = [0, 62];
  const root = { ...tileJson(0, 0, 0, bottom, top), transform: cityTransform() };
  const tileset = { asset: { version: '1.1' }, geometricError: 128, root };
  files.set('tileset.json', encoder.encode(JSON.stringify(tileset, null, 1)));
  const compression: Compression = variant === 'draco' || variant === 'meshopt' ? variant : 'none';
  const image = variant === 'ktx2' && ktx2Image ? { bytes: ktx2Image, mimeType: 'image/ktx2' as const } : undefined;
  for (let level = 0; level < CITY_LEVELS; level++)
    for (let x = 0; x < 2 ** level; x++)
      for (let y = 0; y < 2 ** level; y++) {
        const { features, primitives } = tileShapes(level, x, y, ground, image);
        const legacy = level < 2;
        const glb = await writeGlb({
          primitives,
          featureAttribute: legacy ? '_BATCHID' : '_FEATURE_ID_0',
          compression,
          copyright: CITY_COPYRIGHT,
          ...(legacy ? {} : { metadata: { schema: SCHEMA, table: (view) => propertyTable(features, view) } }),
        });
        files.set(`tiles/${level}/${x}/${y}.${legacy ? 'b3dm' : 'glb'}`, legacy ? b3dm(glb, features) : glb);
      }
  return files;
}
