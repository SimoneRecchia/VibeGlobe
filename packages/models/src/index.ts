/**
 * @packageDocumentation
 * glTF 2.0 models for VibeGlobe (F361, ADR 0121): GLB and glTF parsing and validation, Draco and meshopt decoding in
 * workers, node transforms, and a renderer-neutral {@link ModelDescription} that a renderer turns into GPU meshes.
 * @module @vibeglobe/models
 */
export { transferables } from './build.js';
export type {
  AttributeArray,
  ModelAttribute,
  ModelDescription,
  ModelImage,
  ModelImageType,
  ModelInstance,
  ModelMaterial,
  ModelMesh,
  ModelPrimitive,
  ModelSampler,
  ModelTexture,
  PrimitiveMode,
} from './description.js';
export type { DracoDecoderModule, DracoLoader } from './draco.js';
export { ModelError } from './errors.js';
export type { ModelErrorCode } from './errors.js';
export { isGlb, parseGlb } from './glb.js';
export type { GlbChunks } from './glb.js';
export { createModelLoader, poolRunner } from './loader.js';
export type { ModelFetch, ModelLoader, ModelLoaderOptions, ModelTaskRunner, WorkerPoolLike } from './loader.js';
export { loadMeshoptDecoder } from './meshopt.js';
export type { MeshoptDecoderLike, MeshoptLoader } from './meshopt.js';
export { parseModel, readDocument } from './parse.js';
export type { ModelLimits, ParseModelOptions } from './parse.js';
export { externalUris } from './resources.js';
export type { ModelResources } from './resources.js';
export { createModelTasks, loadDraco3d, PARSE_MODEL_TASK } from './tasks.js';
export type { ModelTaskOptions, ParseModelTaskInput } from './tasks.js';
export { meshNodes, nodeMatrix } from './transforms.js';
export type { MeshNode } from './transforms.js';
export { SUPPORTED_EXTENSIONS, validateGltf } from './validate.js';
