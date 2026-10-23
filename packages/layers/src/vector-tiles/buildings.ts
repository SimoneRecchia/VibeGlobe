/**
 * Building heights and extrusion geometry (F455, F456, F458; ADR 0041). Heights come from the tags in this order:
 * `height` / `render_height`, else `building:levels` × {@link LEVEL_HEIGHT_METERS}, else the default for the building
 * type ({@link DEFAULT_BUILDING_HEIGHTS}); bases from `min_height` / `render_min_height`, else `building:min_level` ×
 * the level height. A height depends only on the feature's tags, so the same building has the same height in every
 * tile. Walls on the tile's clip edge are not built, so a building split across tiles has no inner walls.
 */
import earcut from 'earcut';
import { classifyRings, clipRing, type ClipRect, type TilePoint, type TileRing } from './fill-tessellate.js';

/** Height of one storey, in meters (the OpenStreetMap wiki's usual value for `building:levels`). */
export const LEVEL_HEIGHT_METERS = 3;

/**
 * Default heights in meters by `building` type, for buildings without height or level tags. Documented in
 * `docs/guides/data-layers.md` (buildings section).
 */
export const DEFAULT_BUILDING_HEIGHTS: Readonly<Record<string, number>> = Object.freeze({
  house: 6,
  detached: 6,
  semidetached_house: 6,
  terrace: 9,
  residential: 12,
  apartments: 15,
  commercial: 12,
  retail: 6,
  office: 18,
  hotel: 18,
  industrial: 8,
  warehouse: 8,
  church: 20,
  cathedral: 35,
  chapel: 8,
  mosque: 15,
  temple: 12,
  school: 10,
  university: 15,
  hospital: 18,
  public: 12,
  civic: 12,
  train_station: 15,
  garage: 3,
  garages: 3,
  carport: 3,
  shed: 3,
  hut: 3,
  roof: 4,
  greenhouse: 4,
  farm: 6,
  barn: 8,
  yes: 8,
});

/** The height used for a type absent from the table. */
export const FALLBACK_BUILDING_HEIGHT_METERS = DEFAULT_BUILDING_HEIGHTS['yes'] ?? 8;

/** Where a building's height came from. */
export type HeightSource = 'height' | 'levels' | 'default';

/** A building's vertical extent in meters. */
export interface BuildingHeight {
  readonly baseMeters: number;
  readonly heightMeters: number;
  readonly source: HeightSource;
}

/** Parses an OpenStreetMap length: plain meters, `m`, or feet (`ft`, `'`); undefined when it is not a length. */
export function parseLength(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const match = /^\s*(\d+(?:[.,]\d+)?)\s*(m|ft|')?\s*$/i.exec(value);
  if (match === null) return undefined;
  const number = Number((match[1] ?? '').replace(',', '.'));
  const unit = (match[2] ?? 'm').toLowerCase();
  return unit === 'm' ? number : number * 0.3048;
}

/** The height and base of a building from its tags (raw OpenStreetMap or OpenMapTiles `render_*`). */
export function buildingHeight(properties: Readonly<Record<string, unknown>>): BuildingHeight {
  const tagged = parseLength(properties['height']) ?? parseLength(properties['render_height']);
  const levels = parseLength(properties['building:levels']);
  const base =
    parseLength(properties['min_height']) ??
    parseLength(properties['render_min_height']) ??
    (parseLength(properties['building:min_level']) ?? 0) * LEVEL_HEIGHT_METERS;
  let height: number;
  let source: HeightSource;
  if (tagged !== undefined) {
    height = tagged;
    source = 'height';
  } else if (levels !== undefined) {
    height = levels * LEVEL_HEIGHT_METERS;
    source = 'levels';
  } else {
    const type = String(properties['building'] ?? properties['building:part'] ?? 'yes');
    height = DEFAULT_BUILDING_HEIGHTS[type] ?? FALLBACK_BUILDING_HEIGHT_METERS;
    source = 'default';
  }
  return { baseMeters: Math.min(base, height), heightMeters: Math.max(height, base), source };
}

/** A building footprint feature: MVT rings in tile coordinates and its tags. */
export interface BuildingFeature {
  readonly id?: string | number | undefined;
  readonly rings: readonly TileRing[];
  readonly properties: Readonly<Record<string, unknown>>;
}

function centroid(ring: TileRing): TilePoint {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p[0];
    y += p[1];
  }
  return [x / ring.length, y / ring.length];
}

function contains(ring: TileRing, p: TilePoint): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as TilePoint;
    const b = ring[j] as TilePoint;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/**
 * Applies building parts: an outline that contains `building:part` features (or carries `hide_3d`, as OpenMapTiles
 * marks such outlines) is not extruded, so its parts replace it.
 * @returns the features to extrude.
 */
export function resolveBuildingParts(features: readonly BuildingFeature[]): BuildingFeature[] {
  const parts = features.filter((f) => f.properties['building:part'] !== undefined);
  return features.filter((feature) => {
    if (feature.properties['hide_3d'] === true || feature.properties['hide_3d'] === 'true') return false;
    if (feature.properties['building:part'] !== undefined) return true;
    const outline = feature.rings[0];
    if (outline === undefined) return false;
    return !parts.some((part) => part.rings[0] !== undefined && contains(outline, centroid(part.rings[0])));
  });
}

/**
 * Extrusion triangles. Per vertex: `positions` (x, y in tile units, z in meters), `normals` (unit, z up; walls get
 * one normal per wall for flat shading, so walls facing different directions shade differently, F457).
 */
export interface ExtrusionGeometry {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
}

function onEdge(a: TilePoint, b: TilePoint, rect: ClipRect): boolean {
  return (
    (a[0] === b[0] && (a[0] <= rect.minX || a[0] >= rect.maxX)) ||
    (a[1] === b[1] && (a[1] <= rect.minY || a[1] >= rect.maxY))
  );
}

/** Builds walls and a flat roof for one building, clipped to `rect` (walls on its edge are skipped). */
export function extrudeBuilding(rings: readonly TileRing[], height: BuildingHeight, rect: ClipRect): ExtrusionGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const vertex = (x: number, y: number, z: number, nx: number, ny: number, nz: number): number => {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
    return normals.length / 3 - 1;
  };
  const top = height.heightMeters;
  const bottom = height.baseMeters;
  for (const polygon of classifyRings(rings)) {
    const flat: number[] = [];
    const holes: number[] = [];
    for (const [index, ring] of polygon.entries()) {
      const clipped = clipRing(ring, rect);
      if (clipped.length < 3) continue;
      if (index > 0) holes.push(flat.length / 2);
      for (let i = 0; i < clipped.length; i++) {
        const a = clipped[i] as TilePoint;
        const b = clipped[(i + 1) % clipped.length] as TilePoint;
        flat.push(a[0], a[1]);
        if (onEdge(a, b, rect) || top <= bottom) continue;
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (length === 0) continue;
        // Outward normal of an exterior ring that is clockwise on screen (y down), and of a hole (opposite winding).
        const nx = (b[1] - a[1]) / length;
        const ny = -(b[0] - a[0]) / length;
        const v0 = vertex(a[0], a[1], bottom, nx, ny, 0);
        const v1 = vertex(b[0], b[1], bottom, nx, ny, 0);
        const v2 = vertex(b[0], b[1], top, nx, ny, 0);
        const v3 = vertex(a[0], a[1], top, nx, ny, 0);
        indices.push(v0, v1, v2, v0, v2, v3);
      }
    }
    if (flat.length < 6 || holes[0] === 0) continue;
    const base = normals.length / 3;
    for (let i = 0; i < flat.length; i += 2) vertex(flat[i] ?? 0, flat[i + 1] ?? 0, top, 0, 0, 1);
    for (const index of earcut(flat, holes, 2)) indices.push(base + index);
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
  };
}

/**
 * The factor that scales building heights on the flat Web Mercator map at a latitude: the projection's scale factor
 * `1 / cos(latitude)`, so a building keeps its proportion to the ground around it (F458). Measurements stay in meters.
 */
export function flatMapHeightScale(latitudeDeg: number): number {
  const clamped = Math.max(-85.0511, Math.min(85.0511, latitudeDeg));
  return 1 / Math.cos((clamped * Math.PI) / 180);
}
