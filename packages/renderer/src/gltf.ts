/**
 * @packageDocumentation
 * The glTF 2.0 loader for models (F361, ADR 0037), a separate entry point so applications without models never load it:
 * `createRenderer({ gltf: gltfLoader })`.
 * @module @vibeglobe/renderer/gltf
 */
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GltfLoaderFactory } from './layer-models.js';

/** Creates three.js's glTF loader (PBR materials, textures; .glb and .gltf with external resources). */
export const gltfLoader: GltfLoaderFactory = () => Promise.resolve(new GLTFLoader());
