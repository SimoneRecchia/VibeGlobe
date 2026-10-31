// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * @packageDocumentation
 * The glTF 2.0 loader for models (F361, ADR 0037), a separate entry point so applications without models never load it:
 * `createRenderer({ gltf: gltfLoader })`.
 * @module @vibeglobe/renderer/gltf
 */
import type { GltfLoaderFactory } from './layer-models.js';

/**
 * Creates three.js's glTF loader (PBR materials, textures; .glb and .gltf with external resources), loading its module
 * with the first model, so a page whose models never show never downloads it (KB-297).
 */
export const gltfLoader: GltfLoaderFactory = async () =>
  new (await import('three/examples/jsm/loaders/GLTFLoader.js')).GLTFLoader();
