// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * What vector tiles draw through (ADR 0131): a renderer-neutral target, as `LayerRenderTarget` is for data layers
 * (ADR 0029, three.js never appears in this package). `@vibeglobe/renderer/vector-tiles` implements it for three.js
 * (`createVectorTileTarget`); tests record what is drawn. Attribute arrays are per vertex, with the sizes given.
 */
export type {
  AtlasRect,
  LabelQuads,
  RasterImage,
  RasterizedGlyph,
  VectorAtlas,
  VectorDraw,
  VectorLayerDraws,
  VectorMesh,
  VectorMeshData,
  VectorMeshKind,
  VectorMeshUpdate,
  VectorTileTarget,
} from '@vibeglobe/core';
