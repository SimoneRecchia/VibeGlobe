// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * @packageDocumentation
 * The worker program of VibeGlobe and the factory that starts it (ADR 0011): `createWorkers()` returns the endpoint
 * factory the engine's worker pool uses to run decoding tasks in module workers loaded from a same-origin URL, with no
 * `blob:` workers and no generated code, so the engine runs under a strict Content Security Policy.
 * @module @vibeglobe/worker
 */
import { workerFactory, type CreateWorkersOptions } from './factory.js';
import type { WorkerEndpointFactory } from './protocol.js';

export { rgba8MipChainBytes } from './decode-image.js';
export type { DecodedImage, DecodeImageInput } from './decode-image.js';
export { createTranscodeKtx2 } from './transcode-ktx2.js';
export type { TranscodeKtx2Input, TranscoderLoader } from './transcode-ktx2.js';
export { TaskError, WORKER_BUILD_ID, WORKER_PROTOCOL_VERSION } from './protocol.js';
export type {
  SerializedTaskError,
  TaskContext,
  TaskErrorCode,
  TaskFunction,
  TaskOutput,
  TaskTable,
  WorkerEndpoint,
  WorkerEndpointFactory,
  WorkerCancelMessage,
  WorkerMessage,
  WorkerReadyMessage,
  WorkerReply,
  WorkerRequest,
  WorkerRunMessage,
} from './protocol.js';

export { WorkerConfigError } from './factory.js';
export type { CreateWorkersOptions, WorkerConfigErrorCode } from './factory.js';

/** Pool key and error label of the bundled worker, whose final URL only the bundler knows. */
const BUNDLED_WORKER_LABEL = 'vibeglobe-worker.js (bundled with @vibeglobe/worker)';

function startBundledWorker(): Worker {
  // The literal form, so Vite, webpack 5 and Parcel find and emit the worker entry (ADR 0011 rule 5).
  return new Worker(new URL('./vibeglobe-worker.js', import.meta.url), { type: 'module', name: 'vibeglobe' });
}

/**
 * Creates the endpoint factory of the worker pool: module workers running `vibeglobe-worker.js`, every built-in task
 * (it needs `@vibeglobe/layers` and `@vibeglobe/models` installed, ADR 0172), or the program at `options.url`.
 * Nothing starts until the pool asks for a worker, so calling this has no cost; it only validates the options and
 * throws a {@link WorkerConfigError} for a cross-origin, `blob:` or `data:` URL or an invalid count. An application
 * that draws only imagery and terrain uses `@vibeglobe/worker/basic` instead.
 */
export function createWorkers(options: CreateWorkersOptions = {}): WorkerEndpointFactory {
  return workerFactory(options, BUNDLED_WORKER_LABEL, startBundledWorker, () =>
    import('./tasks.js').then((module) => module.TASKS),
  );
}
