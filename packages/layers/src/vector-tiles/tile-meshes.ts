/**
 * Mesh data of one laid-out bucket (ADR 0131): the worker's globe attributes with the tile units, line extrusions,
 * building heights and circle corners in the layout the renderer's vector materials read. Paint is added by
 * `vector-paint.ts`; ground heights start at 0 and are draped later.
 */
import type { LayerOrigin } from '@vibeglobe/core';
import { globeVertices, maxEdgeUnits } from './globe-vertices.js';
import { BUCKET_BUFFER, BUCKET_EXTENT, DRAPE_EDGE_UNITS, type Bucket } from './layout-tile.js';
import type { TileId } from './tile-pyramid.js';
import type { MeshPaint } from './vector-paint.js';
import type { VectorMeshData, VectorMeshKind } from './vector-target.js';

/** The geometry part of a mesh, and the feature of each vertex (for paint). */
export interface MeshGeometry {
  readonly data: Omit<VectorMeshData, keyof MeshPaint | 'stroke'>;
  readonly featureIndex: Uint32Array;
}

function xyOf(positions: Float32Array, stride: number): Float32Array {
  if (stride === 2) return positions;
  const out = new Float32Array((positions.length / stride) * 2);
  for (let i = 0, j = 0; i < positions.length; i += stride, j += 2) {
    out[j] = positions[i] ?? 0;
    out[j + 1] = positions[i + 1] ?? 0;
  }
  return out;
}

function lineAttributes(extrusions: Float32Array, distances: Float32Array): Float32Array {
  const out = new Float32Array(distances.length * 4);
  for (let i = 0; i < distances.length; i++) {
    out[i * 4] = extrusions[i * 2] ?? 0;
    out[i * 4 + 1] = extrusions[i * 2 + 1] ?? 0;
    out[i * 4 + 2] = distances[i] ?? 0;
  }
  return out;
}

function extrusionAttributes(positions: Float32Array, featureIndex: Uint32Array) {
  const n = featureIndex.length;
  const height = new Float32Array(n);
  const tops = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const z = positions[i * 3 + 2] ?? 0;
    height[i] = z;
    const f = featureIndex[i] ?? 0;
    tops.set(f, Math.max(tops.get(f) ?? 0, z));
  }
  const top = new Float32Array(n);
  for (let i = 0; i < n; i++) top[i] = tops.get(featureIndex[i] ?? 0) ?? 0;
  return { height, top };
}

const CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1];

/** Expands one vertex per point into a quad of four, each with its corner. */
function circleGeometry(
  kind: VectorMeshKind,
  origin: LayerOrigin,
  g: NonNullable<Bucket['geometry']>,
): MeshGeometry | undefined {
  const globe = g.globe;
  if (globe === undefined) return undefined;
  const points = g.featureIndex.length;
  const expand = (array: Float32Array, size: number) => {
    const out = new Float32Array(points * 4 * size);
    for (let p = 0; p < points; p++)
      for (let c = 0; c < 4; c++) out.set(array.subarray(p * size, p * size + size), (p * 4 + c) * size);
    return out;
  };
  const indices = new Uint32Array(points * 6);
  const featureIndex = new Uint32Array(points * 4);
  const corners = new Float32Array(points * 8);
  for (let p = 0; p < points; p++) {
    indices.set([p * 4, p * 4 + 1, p * 4 + 2, p * 4, p * 4 + 2, p * 4 + 3], p * 6);
    featureIndex.fill(g.featureIndex[p] ?? 0, p * 4, p * 4 + 4);
    corners.set(CORNERS, p * 8);
  }
  return {
    featureIndex,
    data: {
      kind,
      ...origin,
      positions: expand(globe.positions, 3),
      normals: expand(globe.normals, 3),
      planes: expand(globe.planes, 4),
      tile: expand(g.positions, 2),
      indices,
      ground: new Float32Array(points * 4),
      corners,
    },
  };
}

/** The mesh geometry of a bucket laid out with its tile (`LayoutInput.tile`); undefined when it draws nothing. */
export function meshGeometry(kind: VectorMeshKind, bucket: Bucket, origin: LayerOrigin): MeshGeometry | undefined {
  const g = bucket.geometry;
  if (g === undefined || g.globe === undefined || g.featureIndex.length === 0) return undefined;
  if (kind === 'circle') return circleGeometry(kind, origin, g);
  if (g.indices.length === 0) return undefined;
  const stride = kind === 'extrusion' ? 3 : 2;
  const base = {
    kind,
    ...origin,
    positions: g.globe.positions,
    normals: g.globe.normals,
    planes: g.globe.planes,
    tile: xyOf(g.positions, stride),
    indices: g.indices,
    ground: new Float32Array(g.featureIndex.length),
  };
  if (kind === 'line' && g.side !== undefined && g.extrusions !== undefined && g.distances !== undefined) {
    return {
      featureIndex: g.featureIndex,
      data: { ...base, side: g.side, line: lineAttributes(g.extrusions, g.distances) },
    };
  }
  if (kind === 'extrusion') {
    const shadeNormals = g.normals ?? new Float32Array(g.featureIndex.length * 3);
    return {
      featureIndex: g.featureIndex,
      data: { ...base, ...extrusionAttributes(g.positions, g.featureIndex), shadeNormals },
    };
  }
  return kind === 'fill' ? { featureIndex: g.featureIndex, data: base } : undefined;
}

/**
 * The bucket of a `background` layer for one tile: its whole square as one feature, split into cells that follow the
 * globe's curvature like fills do.
 */
export function backgroundBucket(tile: TileId, layerId: string): Bucket {
  // As fine as fills: following the globe's curvature, and the relief when draped. Grid lines fall on the tile's
  // edges (draped neighbors share those vertices exactly), with one more line a buffer beyond each edge.
  const inner = Math.ceil(BUCKET_EXTENT / Math.min(maxEdgeUnits(tile.z, BUCKET_EXTENT), 2 * DRAPE_EDGE_UNITS));
  const lines = [
    -BUCKET_BUFFER,
    ...Array.from({ length: inner + 1 }, (_, i) => (i * BUCKET_EXTENT) / inner),
    BUCKET_EXTENT + BUCKET_BUFFER,
  ];
  const cells = lines.length - 1;
  const side = lines.length;
  const positions = new Float32Array(side * side * 2);
  for (let j = 0; j < side; j++)
    for (let i = 0; i < side; i++) positions.set([lines[i] ?? 0, lines[j] ?? 0], (j * side + i) * 2);
  const indices = new Uint32Array(cells * cells * 6);
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const a = j * side + i;
      indices.set([a, a + 1, a + side + 1, a, a + side + 1, a + side], (j * cells + i) * 6);
    }
  }
  return {
    layerId,
    type: 'background',
    features: [{ id: undefined, type: 'Polygon', properties: {} }],
    geometry: {
      positions,
      indices,
      featureIndex: new Uint32Array(side * side),
      globe: globeVertices(tile, BUCKET_EXTENT, positions, 2),
    },
  };
}
