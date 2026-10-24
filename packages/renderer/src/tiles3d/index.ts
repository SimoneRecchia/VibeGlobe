// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * @packageDocumentation
 * 3D Tiles and glTF meshes for the three.js renderer (M13, ADR 0141): {@link buildModelMeshes} turns a
 * `ModelDescription` of `@vibeglobe/models` into three.js meshes (the data layers' models reuse it), and
 * {@link threeTileMeshes} gives the tileset loader of `@vibeglobe/sources/tiles3d` its meshes in a render extension.
 * A separate entry point, so applications without 3D Tiles never load it.
 * @module @vibeglobe/renderer/tiles3d
 */
export { buildModelMeshes, decodeBrowserImage } from './model-meshes.js';
export type { ImageDecoder, ModelMeshes, ModelMeshOptions, RawImage } from './model-meshes.js';
export { ThreeTileMeshes, threeTileMeshes } from './tile-meshes.js';
export type { TileMeshContext, TileMeshHit } from './tile-meshes.js';
