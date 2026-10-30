// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * What vector tiles draw through (ADR 0131): a renderer-neutral target, as `LayerRenderTarget` is for data layers
 * (ADR 0029, three.js never appears in this package). `@vibeglobe/renderer/vector-tiles` implements it for three.js
 * (`createVectorTileTarget`); tests record what is drawn. Attribute arrays are per vertex, with the sizes given.
 */
import type { FrameView } from '@vibeglobe/core';

/** What a mesh draws: `raster` is a textured tile square (raster, hillshade and heatmap layers, F445). */
export type VectorMeshKind = 'fill' | 'line' | 'extrusion' | 'circle' | 'raster';

/** The image of a raster mesh: straight sRGB RGBA rows, top row first, covering the tile square. */
export interface RasterImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}

/** One tile's mesh of one style layer. */
export interface VectorMeshData {
  readonly kind: VectorMeshKind;
  readonly originEcef: Float64Array;
  readonly planeCenter: Float64Array;
  /** Offsets from the origin (3), ellipsoid normals (3), Web Mercator plane offsets (4). */
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly planes: Float32Array;
  /** Tile units (2). */
  readonly tile: Float32Array;
  readonly indices: Uint32Array;
  /** Paint at the integer zooms A and B around the camera's: straight linear RGBA (4) and parameters (4). */
  readonly colorA: Float32Array;
  readonly colorB: Float32Array;
  readonly paramsA: Float32Array;
  readonly paramsB: Float32Array;
  /** Terrain height under the vertex (1), meters. */
  readonly ground: Float32Array;
  /** Lines: the side point's globe attributes, and (ex, ey, distance, 0). */
  readonly side?: { readonly positions: Float32Array; readonly normals: Float32Array; readonly planes: Float32Array };
  readonly line?: Float32Array;
  /** Extrusions: height above the ground (1), the building's top (1), the shading normal (3). */
  readonly height?: Float32Array;
  readonly top?: Float32Array;
  readonly shadeNormals?: Float32Array;
  /** Circles: corner (2) and stroke color (4). */
  readonly corners?: Float32Array;
  readonly stroke?: Float32Array;
  /** Rasters: the tile's image; paint `colorA.w` is the opacity, `paramsA` brightness min and max, saturation, contrast. */
  readonly image?: RasterImage;
}

/** Attributes replaced in place (same lengths). */
export type VectorMeshUpdate = Partial<
  Pick<VectorMeshData, 'colorA' | 'colorB' | 'paramsA' | 'paramsB' | 'ground' | 'stroke'>
>;

/** A mesh on the target. */
export interface VectorMesh {
  update(attributes: VectorMeshUpdate): void;
  dispose(): void;
}

/** One draw of a mesh, clipped to a target square (tile units), with CSS pixels per tile unit (dashes). */
export interface VectorDraw {
  readonly mesh: VectorMesh;
  readonly clip: readonly [number, number, number, number];
  readonly pxPerUnit: number;
  /** The factor between the mesh's paints A and B when not its layer's: a mesh still painted for another zoom pair. */
  readonly zoomT?: number;
}

/** One style layer's draws of a frame. */
export interface VectorLayerDraws {
  readonly layerId: string;
  readonly kind: VectorMeshKind;
  readonly opacity: number;
  readonly zoomT: number;
  readonly dash?: readonly number[];
  readonly solid?: boolean;
  /** Extrusions: the share of their height drawn (they grow as their layer fades in, F457). */
  readonly heightScale?: number;
  readonly draws: readonly VectorDraw[];
}

/** The label quads of a frame (four vertices each): screen corners in CSS pixels, atlas texels, colors, parameters. */
export interface LabelQuads {
  readonly quads: number;
  readonly screen: Float32Array;
  readonly uv: Float32Array;
  readonly fill: Float32Array;
  readonly halo: Float32Array;
  /** Glyph scale (text size / 24), halo width in CSS pixels, opacity, 1 for an icon. */
  readonly params: Float32Array;
}

/** A packed atlas entry, in texels. */
export interface AtlasRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The glyph and icon atlas of the target. */
export interface VectorAtlas {
  /** Increases when the atlas starts over; entries must be added again. */
  readonly generation: number;
  get(key: string): AtlasRect | undefined;
  addSdf(key: string, bitmap: ArrayLike<number>, width: number, height: number): AtlasRect | undefined;
  addRgba(key: string, pixels: ArrayLike<number>, width: number, height: number): AtlasRect | undefined;
}

/** A glyph drawn locally (the glyph PBF layout: a 3-texel border around `width` × `height`). */
export interface RasterizedGlyph {
  readonly id: number;
  readonly bitmap: readonly number[];
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly advance: number;
}

/** The target of vector tiles. */
export interface VectorTileTarget {
  readonly atlas: VectorAtlas;
  /** Draws SDF glyphs in a CSS font family, for characters the style's glyphs lack; absent where it cannot. */
  readonly rasterizeGlyphs?: (fontWeight: string, fontFamily: string, codes: readonly number[]) => RasterizedGlyph[];
  createMesh(data: VectorMeshData): VectorMesh;
  /** Draws a frame: the layers in order, then the labels set last. */
  draw(layers: readonly VectorLayerDraws[], view: FrameView): void;
  setLabels(labels: LabelQuads | undefined): void;
  removeLayer(layerId: string): void;
  dispose(): void;
}
