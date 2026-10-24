// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { TaskTable } from '@vibeglobe/core';
import { transferables } from './build.js';
import type { DracoDecoderModule, DracoLoader } from './draco.js';
import type { MeshoptLoader } from './meshopt.js';
import { parseModel, type ModelLimits } from './parse.js';

/** Name of the worker task that parses and decodes a model. */
export const PARSE_MODEL_TASK = 'parse-model';

/** Input of the `parse-model` task: the model file and its external files, all transferred. */
export interface ParseModelTaskInput {
  readonly bytes: ArrayBuffer;
  readonly resources?: Readonly<Record<string, ArrayBuffer>>;
  readonly limits?: ModelLimits;
  /**
   * Where the consumer hosts Draco's `draco_decoder.wasm` (ADR 0015), for the task's default Draco loader; in Node the
   * decoder package finds its own file.
   */
  readonly dracoWasmUrl?: string;
}

/** Decoders the worker's model task uses. */
export interface ModelTaskOptions {
  /** Loads the Draco decoder module in the worker (default: {@link loadDraco3d}). */
  readonly draco?: DracoLoader;
  readonly meshopt?: MeshoptLoader;
}

/**
 * The default Draco loader: Google's `draco3d` decoder (Apache-2.0), loaded once per worker on the first Draco model.
 * `wasmUrl` is where the consumer hosts `draco_decoder.wasm` (ADR 0015: the project runs no servers); in Node the
 * package finds its own file.
 */
export function loadDraco3d(wasmUrl?: string): DracoLoader {
  let module: Promise<DracoDecoderModule> | undefined;
  return () => {
    module ??= import('draco3d').then(
      ({ createDecoderModule }) =>
        createDecoderModule(wasmUrl === undefined ? {} : { locateFile: () => wasmUrl }) as Promise<DracoDecoderModule>,
    );
    return module;
  };
}

/**
 * The worker task table of this package (ADR 0011, ADR 0121): `parse-model` parses, validates and decodes a model
 * (Draco and meshopt included) and returns its {@link ModelDescription} with every array transferred. A failure
 * throws a ModelError whose `code` becomes the task's error code. The engine's worker program registers this table
 * next to its own tasks (hook request), so decoding never runs on the main thread.
 */
export function createModelTasks(options: ModelTaskOptions = {}): TaskTable {
  // One Draco loader per decoder location, each loading its module once.
  const dracoLoaders = new Map<string | undefined, DracoLoader>();
  const dracoFor = (url: string | undefined): DracoLoader => {
    let loader = dracoLoaders.get(url);
    if (!loader) dracoLoaders.set(url, (loader = loadDraco3d(url)));
    return loader;
  };
  return Object.freeze({
    [PARSE_MODEL_TASK]: async (input: unknown) => {
      const value = input as ParseModelTaskInput;
      const resources: Record<string, Uint8Array> = {};
      for (const [uri, buffer] of Object.entries(value.resources ?? {})) resources[uri] = new Uint8Array(buffer);
      const model = await parseModel(new Uint8Array(value.bytes), {
        resources,
        draco: options.draco ?? dracoFor(value.dracoWasmUrl),
        ...(options.meshopt ? { meshopt: options.meshopt } : {}),
        ...(value.limits ? { limits: value.limits } : {}),
      });
      return { output: model, transfer: transferables(model) };
    },
  });
}
