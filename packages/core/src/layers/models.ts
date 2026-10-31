// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
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
  /** The pick id a pick at the model returns (data layers' model features, F379); 0 for none. */
  setPickId?(id: number, pickId: number): void;
  /** Blends the model toward a color, `[r, g, b, amount]` from 0 to 1 (selection and hover styles, F381); `undefined` clears it. */
  setHighlight?(id: number, rgba: readonly [number, number, number, number] | undefined): void;
  /** Shows or hides a model, or a set of models. */
  setVisible?(id: number, visible: boolean): void;
  /**
   * Loads one model for many copies drawn instanced (F627, `ModelSetLayer`); resolves with the set's id, which
   * `remove` and `setVisible` also take.
   */
  loadSet?(source: { readonly url?: string; readonly data?: ArrayBuffer }, options: ModelSetOptions): Promise<number>;
  /** Sets the copies of a set: their poses, and the pick id of each (0 for none). */
  setInstances?(id: number, poses: readonly ModelPose[], pickIds: readonly number[]): void;
  /** Blends one copy of a set toward a color, `[r, g, b, amount]`; `undefined` clears it. */
  setInstanceHighlight?(id: number, index: number, rgba: readonly [number, number, number, number] | undefined): void;
  /**
   * Turns each copy's joint `joint` (an index into `ModelSetOptions.joints`, F648) by its angle in `anglesRad`, by copy
   * index, from the next frame on; the renderer keeps the array and reads it every frame, so the caller updates it in
   * place.
   */
  setInstanceAngles?(id: number, joint: number, anglesRad: Float32Array): void;
  /** How many copies of a set the last frame drew as the model (in view and near the eye). */
  drawnInstances?(id: number): number;
}

/** How a set of models draws its copies (F627). */
export interface ModelSetOptions {
  /** Copies nearer the eye than this are drawn as the model, farther ones as the placeholder, meters. */
  readonly visibleBelowMeters: number;
  /** The placeholder's color, `[r, g, b]` from 0 to 1. */
  readonly placeholderColor: readonly [number, number, number];
  /** The placeholder's size on screen, CSS pixels; 0 draws none. */
  readonly placeholderSizePx: number;
  /** Nodes of the model that turn with their children by an angle per copy, outermost first (F648). */
  readonly joints?: readonly ModelSetJoint[];
}

/** A glTF node of a set's model that turns, with its children, about one of its own axes (F648). */
export interface ModelSetJoint {
  readonly node: string;
  /** 'y' for a nacelle yawing on its tower, 'z' for a rotor on its shaft. */
  readonly axis: 'y' | 'z';
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
