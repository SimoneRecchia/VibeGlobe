import { GlobeError } from '../globe/errors.js';
import type { GeoPosition, RendererBackend } from '../globe/types.js';
import { validatePosition } from '../globe/validation.js';

/** Where and how a glTF model stands (F361): orientation relative to the local east, north and up axes. */
export interface ModelPose {
  readonly position: GeoPosition;
  /** Clockwise from north, degrees (default 0). */
  readonly headingDeg?: number;
  /** Nose up, degrees (default 0). */
  readonly pitchDeg?: number;
  /** Right wing down, degrees (default 0). */
  readonly rollDeg?: number;
  /** Uniform scale (default 1). */
  readonly scale?: number;
}

/** A glTF 2.0 model to add to a globe: a `.glb` or `.gltf` URL (external resources relative to it) or `.glb` bytes. */
export interface ModelOptions extends ModelPose {
  readonly url?: string;
  readonly data?: ArrayBuffer;
}

/** A model on a globe. */
export interface ModelHandle {
  /** Moves or turns the model; shown from the next frame. */
  setPose(pose: ModelPose): void;
  /** Removes the model and frees its GPU resources. */
  remove(): void;
}

/** The renderer's side of models (ADR 0037): loads and places them each frame. */
export interface ModelRenderer {
  /** Loads a model; resolves with its id, rejects with the loader's error for a missing, truncated or corrupt file. */
  load(source: { readonly url?: string; readonly data?: ArrayBuffer }): Promise<number>;
  setPose(id: number, pose: ModelPose): void;
  remove(id: number): void;
}

/** Throws a GlobeError unless the pose is valid. */
function validatePose(pose: ModelPose): void {
  validatePosition(pose.position);
  for (const [name, value] of [
    ['headingDeg', pose.headingDeg],
    ['pitchDeg', pose.pitchDeg],
    ['rollDeg', pose.rollDeg],
  ] as const)
    if (value !== undefined && !Number.isFinite(value))
      throw new GlobeError('invalid-option', `${name} must be a finite number`);
  if (pose.scale !== undefined && !(pose.scale > 0 && Number.isFinite(pose.scale)))
    throw new GlobeError('invalid-option', 'scale must be a positive number');
}

/**
 * Adds a glTF model to a globe's renderer (F361, ADR 0037). Invalid options reject with a GlobeError; a file the loader
 * cannot read rejects with 'invalid-option' carrying the loader's error.
 */
export async function addModel(
  renderer: RendererBackend | undefined,
  options: ModelOptions,
  requestRender: () => void,
): Promise<ModelHandle> {
  validatePose(options);
  if ((options.url === undefined) === (options.data === undefined))
    throw new GlobeError('invalid-option', 'A model needs either a url or data');
  const models = renderer?.models;
  if (!models) throw new GlobeError('invalid-option', 'The globe has no model renderer yet: wait for globe.ready');
  let id: number;
  try {
    id = await models.load(options);
  } catch (cause) {
    throw new GlobeError('invalid-option', 'The model could not be loaded', { cause });
  }
  models.setPose(id, options);
  requestRender();
  return {
    setPose: (pose) => {
      validatePose(pose);
      models.setPose(id, pose);
      requestRender();
    },
    remove: () => {
      models.remove(id);
      requestRender();
    },
  };
}
