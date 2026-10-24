/**
 * @packageDocumentation
 * The basic worker program (ADR 0172): `createWorkers()` like `@vibeglobe/worker`'s, starting a program with only the
 * imagery, terrain, KTX2 and vector-parser tasks. It needs neither `@vibeglobe/layers` nor `@vibeglobe/models`, so an
 * application with only the core, the renderer and its sources installs neither (F532). Use the package's main entry
 * for data layers' clustering, vector tiles and glTF models.
 * @module @vibeglobe/worker/basic
 */
import { workerFactory, type CreateWorkersOptions } from './factory.js';
import type { WorkerEndpointFactory } from './protocol.js';

export { WorkerConfigError } from './factory.js';
export type { CreateWorkersOptions, WorkerConfigErrorCode } from './factory.js';

/** Pool key and error label of the bundled basic worker. */
const BASIC_WORKER_LABEL = 'vibeglobe-worker-basic.js (bundled with @vibeglobe/worker/basic)';

function startBasicWorker(): Worker {
  // The literal form, so Vite, webpack 5 and Parcel find and emit the worker entry (ADR 0011 rule 5).
  return new Worker(new URL('./vibeglobe-worker-basic.js', import.meta.url), { type: 'module', name: 'vibeglobe' });
}

/**
 * Creates the endpoint factory of the worker pool with the basic worker program, or the program at `options.url`.
 * Nothing starts until the pool asks for a worker; it throws a `WorkerConfigError` for a cross-origin, `blob:` or
 * `data:` URL or an invalid count.
 */
export function createWorkers(options: CreateWorkersOptions = {}): WorkerEndpointFactory {
  return workerFactory(options, BASIC_WORKER_LABEL, startBasicWorker, () =>
    import('./basic-tasks.js').then((module) => module.BASIC_TASKS),
  );
}
