import type { TileDrawList } from '../globe/types.js';
import type { QuadtreeTile } from '../surface/surface-quadtree.hot.js';

/** Texture handle of a draw that samples the world base image (`GlobeOptions.baseImageryUrl`). */
export const BASE_TEXTURE = -1;

/**
 * The per-frame list of surface tile draws (M3 plan §2.2): a struct of typed arrays, reused every frame and grown only
 * on a slow path, so filling it allocates nothing (ADR 0018).
 */
export class DrawList implements TileDrawList {
  count = 0;
  meshKeys: Float64Array;
  textures: Int32Array;
  uvTransforms: Float32Array;
  geographic: Uint8Array;

  constructor(capacity = 256) {
    this.meshKeys = new Float64Array(capacity);
    this.textures = new Int32Array(capacity);
    this.uvTransforms = new Float32Array(capacity * 4);
    this.geographic = new Uint8Array(capacity);
  }

  /** Makes room for `count` draws, keeping none of the current ones (called before a frame fills the list). */
  reserve(count: number): void {
    if (count <= this.meshKeys.length) return;
    this.grow(count);
  }

  private grow(count: number): void {
    let capacity = this.meshKeys.length;
    while (capacity < count) capacity *= 2;
    this.meshKeys = new Float64Array(capacity);
    this.textures = new Int32Array(capacity);
    this.uvTransforms = new Float32Array(capacity * 4);
    this.geographic = new Uint8Array(capacity);
  }
}

/**
 * Draws the first `count` tiles of a selection with the world base image, whose mesh keys the surface cache already
 * wrote into `list.meshKeys`. The base image is equirectangular with its top row at the north pole, so each tile
 * samples it through its geographic v (south fraction in latitude).
 */
export function drawOnBaseImage(list: DrawList, tiles: readonly QuadtreeTile[], count: number): void {
  list.count = count;
  for (let index = 0; index < count; index++) {
    const tile = tiles[index];
    if (!tile) continue;
    list.textures[index] = BASE_TEXTURE;
    list.geographic[index] = 1;
    const at = index * 4;
    list.uvTransforms[at] = (tile.eastRad - tile.westRad) / (2 * Math.PI);
    list.uvTransforms[at + 1] = (tile.northRad - tile.southRad) / Math.PI;
    list.uvTransforms[at + 2] = (tile.westRad + Math.PI) / (2 * Math.PI);
    list.uvTransforms[at + 3] = (Math.PI / 2 - tile.northRad) / Math.PI;
  }
}
