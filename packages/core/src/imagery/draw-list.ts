// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { NO_TERRAIN, type TileDrawLayer, type TileDrawList, type TileDrawOverlay } from '../globe/types.js';
import { MERCATOR_ROOT, type QuadtreeTile } from '../surface/surface-quadtree.hot.js';

/** Texture handle of a draw that samples the world base image (`GlobeOptions.baseImageryUrl`). */
export const BASE_TEXTURE = -1;

/**
 * Tone sources from this number up (`TileDrawList.toneSources`, and the overlay slots' alike) are of a layer that
 * matches the imagery below it (`harmonize: 'below'`, F633): `TONE_BELOW` plus `layer × 8 + index in its chain`.
 */
export const TONE_BELOW = 512;

/**
 * The imagery under each draw's own (`TileDrawList.below`, F633), the reference of a layer that matches the imagery
 * below it: the next layer down's texture (or {@link BASE_TEXTURE} for the world base image), its UV transforms (four
 * per draw) and tone source.
 */
export interface TileDrawBelow {
  readonly textures: Int32Array;
  readonly uvTransforms: Float32Array;
  readonly toneSources: Int16Array;
  /** By layer (the tone source's `layer`), the strength of its matching at this frame's zoom, 0 to 1 (F638). */
  readonly strengths: Float32Array;
}

/** Layers whose tone matching strength a frame carries (`TileDrawBelow.strengths`): tone sources count 8 per layer. */
export const TONE_LAYERS = 8;

// The renderer's view of the draws, with tone matching to the imagery below (F633).
declare module '../globe/types.js' {
  interface TileDrawList {
    /** The imagery under each draw's own (F633). */
    readonly below?: TileDrawBelow;
  }
  interface TileDrawOverlay {
    /** The source of each draw's overlay for tone matching, as `TileDrawList.toneSources` (F633). */
    readonly toneSources?: Int16Array;
  }
}

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
  /** 1 when the draw's `from` fields were seeded for a tile drawn for the first time (terrain morphs, F138). */
  seeded: Uint8Array;
  /** Skirt depth added to the mesh's own, meters (terrain shown from a coarser level than the tile's, M4 review). */
  skirtMeters: Float32Array;
  /** The source of each draw's imagery for tone matching, `layer × 8 + chain index`, or -1 (F249). */
  toneSources: Int16Array;
  /** Terrain only: 1 on each edge (north, east, south, west) that samples the stitch texture (KB-178). */
  stitchEdges: Uint8Array;
  /** Terrain only: the coarser terrain tile a draw's stitched edges sample, or -1 (KB-178). */
  stitchTextures: Int32Array;
  /** Terrain only: the UV transforms into the stitch textures, four per draw. */
  stitchTransforms: Float32Array;
  /** Terrain only: the share of its heights a draw keeps on its north and south edges (polar caps, KB-180). */
  heightScales: Float32Array;

  constructor(capacity: number) {
    this.textures = new Int32Array(capacity);
    this.uvTransforms = new Float32Array(capacity * 4);
    this.geographic = new Uint8Array(capacity);
    this.levels = new Int8Array(capacity);
    this.fromTextures = new Int32Array(capacity);
    this.fromUvTransforms = new Float32Array(capacity * 4);
    this.fromGeographic = new Uint8Array(capacity);
    this.fades = new Float32Array(capacity);
    this.seeded = new Uint8Array(capacity);
    this.skirtMeters = new Float32Array(capacity);
    this.toneSources = new Int16Array(capacity).fill(-1);
    this.stitchEdges = new Uint8Array(capacity * 4);
    this.stitchTextures = new Int32Array(capacity).fill(-1);
    this.stitchTransforms = new Float32Array(capacity * 4);
    this.heightScales = new Float32Array(capacity * 2).fill(1);
  }

  /** Draw `index` shows `texture` (with no fade yet) through the transform in `transform[0..3]`. */
  set(index: number, texture: number, level: number, geographic: number, transform: Float64Array | Float32Array): void {
    this.textures[index] = texture;
    this.levels[index] = level;
    this.geographic[index] = geographic;
    this.fromTextures[index] = texture;
    this.fromGeographic[index] = geographic;
    this.fades[index] = 1;
    this.seeded[index] = 0;
    this.skirtMeters[index] = 0;
    const at = index * 4;
    for (let c = 0; c < 4; c++) {
      const value = transform[c] ?? 0;
      this.uvTransforms[at + c] = value;
      this.fromUvTransforms[at + c] = value;
    }
  }
}

/** Overlays a draw can show above its base imagery (F244, F246): further visible layers are left out. */
export const MAX_OVERLAYS = 2;

/**
 * One overlay slot's per-draw arrays (`TileDrawList.overlays`): a layer's, with the `from` imagery of its cross-fades
 * (KB-155), and the overlay's opacity and blend mode.
 */
export class OverlaySlot extends DrawLayer implements TileDrawOverlay {
  opacities: Float32Array;
  blends: Uint8Array;

  constructor(capacity: number) {
    super(capacity);
    this.textures.fill(-1);
    this.opacities = new Float32Array(capacity);
    this.blends = new Uint8Array(capacity);
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
  overlays: OverlaySlot[];
  /** The imagery under each draw's own, with its UV transform and tone source (F633). */
  below: TileDrawBelow;

  constructor(capacity = 256) {
    this.meshKeys = new Float64Array(capacity);
    this.below = belowArrays(capacity);
    this.imagery = new DrawLayer(capacity);
    this.terrain = new DrawLayer(capacity);
    this.overlays = [];
    for (let slot = 0; slot < MAX_OVERLAYS; slot++) this.overlays.push(new OverlaySlot(capacity));
  }

  /** The imagery layer's arrays, for the fades. */
  get imageryLayer(): DrawLayer {
    return this.imagery;
  }
  /** Imagery texture handle of each draw. */
  get textures(): Int32Array {
    return this.imagery.textures;
  }
  /** The tone-matching source of each draw's imagery (F249). */
  get toneSources(): Int16Array {
    return this.imagery.toneSources;
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
  /** No extra skirt depth for imagery (0 for every draw). */
  get skirtMeters(): Float32Array {
    return this.imagery.skirtMeters;
  }

  /** Makes room for `count` draws, keeping none of the current ones (called before a frame fills the list). */
  reserve(count: number): void {
    if (count <= this.meshKeys.length) return;
    let capacity = this.meshKeys.length;
    while (capacity < count) capacity *= 2;
    this.meshKeys = new Float64Array(capacity);
    this.below = belowArrays(capacity);
    this.imagery = new DrawLayer(capacity);
    this.terrain = new DrawLayer(capacity);
    for (let slot = 0; slot < MAX_OVERLAYS; slot++) this.overlays[slot] = new OverlaySlot(capacity);
  }
}

const IDENTITY = new Float64Array([1, 1, 0, 0]);

/** The per-draw arrays of the imagery under each draw's own (F633). */
function belowArrays(capacity: number): TileDrawBelow {
  return {
    textures: new Int32Array(capacity),
    uvTransforms: new Float32Array(capacity * 4),
    toneSources: new Int16Array(capacity),
    strengths: new Float32Array(TONE_LAYERS).fill(1),
  };
}

/** Draws the first `count` tiles on the ellipsoid: no terrain heights (filled in when a terrain source has some). */
export function drawWithoutTerrain(list: DrawList, count: number): void {
  for (let index = 0; index < count; index++) list.terrain.set(index, NO_TERRAIN, -1, 1, IDENTITY);
}

/**
 * Draws the first `count` tiles of a selection with the world base image, whose mesh keys the surface cache already
 * wrote into `list.meshKeys`. The base image is equirectangular with its top row at the north pole, so each tile
 * samples it through its geographic v (south fraction in latitude). Polar cap tiles show their cap's fill instead
 * (KB-211): the base image's polar rows, stretched around the pole, would show as radial stripes.
 */
export function drawOnBaseImage(list: DrawList, tiles: readonly QuadtreeTile[], count: number): void {
  list.count = count;
  for (let index = 0; index < count; index++) {
    const tile = tiles[index];
    if (!tile) continue;
    // The caps' fills (`polar-caps.ts`): -2 for the north cap (root 1), -3 for the south cap (root 2).
    const texture = tile.root === MERCATOR_ROOT ? BASE_TEXTURE : -1 - tile.root;
    list.textures[index] = texture;
    list.geographic[index] = 1;
    list.imageryLevels[index] = -1;
    list.toneSources[index] = -1;
    list.below.textures[index] = texture;
    list.below.toneSources[index] = -1;
    list.fromTextures[index] = texture;
    list.fromGeographic[index] = 1;
    list.fades[index] = 1;
    for (let slot = 0; slot < list.overlays.length; slot++) {
      const overlay = list.overlays[slot];
      if (overlay) overlay.opacities[index] = 0;
    }
    const at = index * 4;
    list.uvTransforms[at] = (tile.eastRad - tile.westRad) / (2 * Math.PI);
    list.uvTransforms[at + 1] = (tile.northRad - tile.southRad) / Math.PI;
    list.uvTransforms[at + 2] = (tile.westRad + Math.PI) / (2 * Math.PI);
    list.uvTransforms[at + 3] = (Math.PI / 2 - tile.northRad) / Math.PI;
    for (let c = 0; c < 4; c++) {
      list.fromUvTransforms[at + c] = list.uvTransforms[at + c] ?? 0;
      list.below.uvTransforms[at + c] = list.uvTransforms[at + c] ?? 0;
    }
  }
}
