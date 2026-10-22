import { NO_TERRAIN, type TileDrawLayer, type TileDrawList } from '../globe/types.js';
import type { QuadtreeTile } from '../surface/surface-quadtree.hot.js';

/** Texture handle of a draw that samples the world base image (`GlobeOptions.baseImageryUrl`). */
export const BASE_TEXTURE = -1;

/** One layer's per-draw arrays, the levels included (what {@link ImageryFades} reads and writes). */
export class DrawLayer implements TileDrawLayer {
  textures: Int32Array;
  uvTransforms: Float32Array;
  geographic: Uint8Array;
  /** The data level each draw shows, -1 for none (diagnostics, F083). */
  levels: Int8Array;
  fromTextures: Int32Array;
  fromUvTransforms: Float32Array;
  fromGeographic: Uint8Array;
  fades: Float32Array;

  constructor(capacity: number) {
    this.textures = new Int32Array(capacity);
    this.uvTransforms = new Float32Array(capacity * 4);
    this.geographic = new Uint8Array(capacity);
    this.levels = new Int8Array(capacity);
    this.fromTextures = new Int32Array(capacity);
    this.fromUvTransforms = new Float32Array(capacity * 4);
    this.fromGeographic = new Uint8Array(capacity);
    this.fades = new Float32Array(capacity);
  }

  /** Draw `index` shows `texture` (with no fade yet) through the transform in `transform[0..3]`. */
  set(index: number, texture: number, level: number, geographic: number, transform: Float64Array | Float32Array): void {
    this.textures[index] = texture;
    this.levels[index] = level;
    this.geographic[index] = geographic;
    this.fromTextures[index] = texture;
    this.fromGeographic[index] = geographic;
    this.fades[index] = 1;
    const at = index * 4;
    for (let c = 0; c < 4; c++) {
      const value = transform[c] ?? 0;
      this.uvTransforms[at + c] = value;
      this.fromUvTransforms[at + c] = value;
    }
  }
}

/**
 * The per-frame list of surface tile draws (M3 plan §2.2): structs of typed arrays, reused every frame and grown only
 * on a slow path, so filling them allocates nothing (ADR 0018). The list's own arrays are its imagery layer;
 * `terrain` holds the terrain heights (ADR 0006 §4).
 */
export class DrawList implements TileDrawList {
  count = 0;
  meshKeys: Float64Array;
  private imagery: DrawLayer;
  terrain: DrawLayer;

  constructor(capacity = 256) {
    this.meshKeys = new Float64Array(capacity);
    this.imagery = new DrawLayer(capacity);
    this.terrain = new DrawLayer(capacity);
  }

  /** The imagery layer's arrays, for the fades. */
  get imageryLayer(): DrawLayer {
    return this.imagery;
  }
  /** Imagery texture handle of each draw. */
  get textures(): Int32Array {
    return this.imagery.textures;
  }
  /** Imagery UV transforms, four per draw. */
  get uvTransforms(): Float32Array {
    return this.imagery.uvTransforms;
  }
  /** 1 where the imagery texture rows are linear in latitude. */
  get geographic(): Uint8Array {
    return this.imagery.geographic;
  }
  /** The imagery level each draw shows, -1 for the world base image (diagnostics, F083). */
  get imageryLevels(): Int8Array {
    return this.imagery.levels;
  }
  /** Imagery each draw fades from. */
  get fromTextures(): Int32Array {
    return this.imagery.fromTextures;
  }
  /** UV transforms of the imagery each draw fades from. */
  get fromUvTransforms(): Float32Array {
    return this.imagery.fromUvTransforms;
  }
  /** Choice of v of the imagery each draw fades from. */
  get fromGeographic(): Uint8Array {
    return this.imagery.fromGeographic;
  }
  /** Imagery fade progress of each draw. */
  get fades(): Float32Array {
    return this.imagery.fades;
  }

  /** Makes room for `count` draws, keeping none of the current ones (called before a frame fills the list). */
  reserve(count: number): void {
    if (count <= this.meshKeys.length) return;
    let capacity = this.meshKeys.length;
    while (capacity < count) capacity *= 2;
    this.meshKeys = new Float64Array(capacity);
    this.imagery = new DrawLayer(capacity);
    this.terrain = new DrawLayer(capacity);
  }
}

const IDENTITY = new Float64Array([1, 1, 0, 0]);

/** Draws the first `count` tiles on the ellipsoid: no terrain heights (filled in when a terrain source has some). */
export function drawWithoutTerrain(list: DrawList, count: number): void {
  for (let index = 0; index < count; index++) list.terrain.set(index, NO_TERRAIN, -1, 1, IDENTITY);
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
    list.imageryLevels[index] = -1;
    list.fromTextures[index] = BASE_TEXTURE;
    list.fromGeographic[index] = 1;
    list.fades[index] = 1;
    const at = index * 4;
    list.uvTransforms[at] = (tile.eastRad - tile.westRad) / (2 * Math.PI);
    list.uvTransforms[at + 1] = (tile.northRad - tile.southRad) / Math.PI;
    list.uvTransforms[at + 2] = (tile.westRad + Math.PI) / (2 * Math.PI);
    list.uvTransforms[at + 3] = (Math.PI / 2 - tile.northRad) / Math.PI;
    for (let c = 0; c < 4; c++) list.fromUvTransforms[at + c] = list.uvTransforms[at + c] ?? 0;
  }
}
