// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The surface material's terrain heights in TSL (ADR 0006 §4, §5): per-draw flags and transforms, the height grids'
 * sampling, and the stitched edges and polar cap fade (KB-178, KB-180).
 */
import {
  clamp,
  float,
  floor,
  Fn,
  If,
  int,
  ivec2,
  min,
  mix,
  select,
  textureLoad,
  textureSize,
  vec2,
  vec4,
} from 'three/tsl';
import { DataTexture, FloatType, NearestFilter, RedFormat, type Node, type TextureNode } from 'three/webgpu';

/**
 * The height grid of a surface without terrain: 2 × 2 vertices at height 0 (one cell, so the sampling below needs no
 * special case). Float32 with nearest filtering, like every height texture (`tile-textures.ts`).
 */
export function createFlatHeights(): DataTexture {
  const texture = new DataTexture(new Float32Array(4), 2, 2, RedFormat, FloatType);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** Bit `bit` (a power of two) of a float holding small integer flags, as 0 or 1. */
export function flag(flags: Node<'float'>, bit: number): Node<'float'> {
  return floor(flags.div(bit)).mod(2);
}

/**
 * The height at `uv` of a grid texture of (cells + 1)² vertices (`terrain/sample-height.ts`, ADR 0006 §5): piecewise
 * linear over cells split along the north-west to south-east diagonal, read with `textureLoad` (no filtering of
 * float textures needed), positions clamped to the tile.
 */
function sampleHeight(heights: TextureNode, uv: Node<'vec2'>): Node<'float'> {
  // textureSize is typed without its components.
  const size = textureSize(heights, int(0)) as unknown as Node<'ivec2'>;
  const cells = float(size.x).sub(1);
  const x = clamp(uv.x, 0, 1).mul(cells);
  const y = clamp(uv.y, 0, 1).mul(cells);
  const col = min(floor(x), cells.sub(1));
  const row = min(floor(y), cells.sub(1));
  const fx = x.sub(col);
  const fy = y.sub(row);
  const at = (dx: number, dy: number): Node<'float'> =>
    textureLoad(heights, ivec2(int(col.add(dx)), int(row.add(dy)))).x;
  const nw = at(0, 0);
  const ne = at(1, 0);
  const sw = at(0, 1);
  const se = at(1, 1);
  const upper = nw.add(ne.sub(nw).mul(fx)).add(se.sub(ne).mul(fy));
  const lower = nw.add(se.sub(sw).mul(fx)).add(sw.sub(nw).mul(fy));
  return select(fx.greaterThanEqual(fy), upper, lower);
}

/** Column `index` of a matrix uniform (the matrix times a unit vector). */
export function column(matrix: Node<'mat4'>, index: number): Node<'vec4'> {
  return matrix.mul(vec4(index === 0 ? 1 : 0, index === 1 ? 1 : 0, index === 2 ? 1 : 0, index === 3 ? 1 : 0));
}

/** Tile coordinates through one transform column, with v linear in latitude when `geographic` is 1. */
export function mapUv(tileUv: Node<'vec3'>, transform: Node<'vec4'>, geographic: Node<'float'>): Node<'vec2'> {
  const v = mix(tileUv.y, tileUv.z, geographic);
  return vec2(tileUv.x.mul(transform.x).add(transform.z), v.mul(transform.y).add(transform.w));
}

/** Within this of 0 or 1, a tile coordinate lies on the tile's edge (mesh rows and columns are k / 16). */
const ON_EDGE = 1e-4;

/** True for a vertex on an edge whose bit is set in `edges` (north 1, east 2, south 4, west 8). */
function onMarkedEdge(tileUv: Node<'vec3'>, edges: Node<'float'>): Node<'bool'> {
  const north = tileUv.y.lessThan(ON_EDGE).and(flag(edges, 1).greaterThan(0.5));
  const east = tileUv.x.greaterThan(1 - ON_EDGE).and(flag(edges, 2).greaterThan(0.5));
  const south = tileUv.y.greaterThan(1 - ON_EDGE).and(flag(edges, 4).greaterThan(0.5));
  const west = tileUv.x.lessThan(ON_EDGE).and(flag(edges, 8).greaterThan(0.5));
  return north.or(east).or(south).or(west);
}

/**
 * The terrain height of a vertex: displaced along the ellipsoid normal by mix(H_from, H_to, morph) (ADR 0006 §4, §5),
 * the morph sampling the second grid only while it runs; edges next to coarser terrain take its heights instead
 * (KB-178), and polar caps fade them to the ellipsoid (KB-180), both from the draw's `tones` columns 2 and 3.
 */
export function terrainHeight(
  tileUv: Node<'vec3'>,
  grids: { heights: TextureNode; fromHeights: TextureNode; stitchHeights: TextureNode },
  transforms: Node<'mat4'>,
  params: Node<'vec4'>,
  tones: Node<'mat4'>,
): Node<'float'> {
  const stitch = column(tones, 2);
  return Fn(() => {
    const h = sampleHeight(grids.heights, mapUv(tileUv, column(transforms, 2), flag(params.x, 4))).toVar();
    If(params.z.lessThan(1), () => {
      const from = sampleHeight(grids.fromHeights, mapUv(tileUv, column(transforms, 3), flag(params.x, 8)));
      h.assign(mix(from, h, params.z));
    });
    If(onMarkedEdge(tileUv, stitch.x), () => {
      h.assign(sampleHeight(grids.stitchHeights, mapUv(tileUv, column(tones, 3), flag(params.x, 4))));
    });
    return h.mul(mix(stitch.z, stitch.w, tileUv.z));
  })();
}
