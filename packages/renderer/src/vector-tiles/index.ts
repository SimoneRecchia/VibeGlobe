// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Vector tile rendering for the three.js renderer (M13, ADR 0131): the mesh target that
 * `@vibeglobe/layers/vector-tiles` draws through, and the SDF atlas and text material of labels (ADR 0132), which
 * data-layer labels use too (F358).
 * @packageDocumentation
 */
export { createVectorTileTarget, ThreeVectorTarget } from './vector-target.js';
export type {
  LabelQuads,
  VectorDraw,
  VectorLayerDraws,
  VectorMesh,
  VectorMeshData,
  VectorMeshUpdate,
} from './vector-target.js';
export { SdfAtlas } from './sdf-atlas.js';
export type { AtlasRect } from './sdf-atlas.js';
export { createTextMaterial, setTextViewport } from './text-material.js';
export { createVectorMaterial, setVectorFrame, setVectorLayer } from './vector-material.js';
export type { VectorDrawUniforms, VectorMeshKind } from './vector-material.js';
export { rasterizeSdfGlyphs, sdfFromCoverage } from './local-glyphs.js';
export type { LocalGlyph } from './local-glyphs.js';
