// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * glTF decoding of 3D Tiles content (F463; ADR 0141): the `parse-model` task of `@vibeglobe/models` on the engine's
 * worker pool (Draco, meshopt; their decoders load in the worker on the first content that needs them). While the
 * worker program does not register the task (hook request E (1)), the loader's own model worker runs it (a module
 * worker the application starts with `createModelTasks()`), else its own task table on the main thread, once the pool
 * has answered `unknown-task`.
 */
import type { TaskTable, WorkerPool, WorkerTaskOutcome } from '@vibeglobe/core';

/** A decode the caller may cancel. */
export interface DecodeJob {
  readonly cancelled: boolean;
  /** Ids of the worker tasks running for the job, for cancellation and reprioritization. */
  readonly tasks: Set<number>;
}

/** A worker of the application's own that runs `parse-model` (`ParseModelTaskInput` in, `ModelDescription` out). */
export interface ModelWorker {
  decode(bytes: ArrayBuffer): Promise<unknown>;
}

/** Thrown when the job was cancelled while decoding. */
export class DecodeCancelled extends Error {}

/** Decodes GLB bytes into a `ModelDescription`. */
export class ModelDecoder {
  private workersHaveTask = true;

  constructor(
    private readonly workers: WorkerPool | undefined,
    private readonly fallback: TaskTable | undefined,
    private readonly ownWorker: ModelWorker | undefined = undefined,
    /** Where the consumer hosts `draco_decoder.wasm`, for the engine's `parse-model` (ADR 0015). */
    private readonly dracoWasmUrl: string | undefined = undefined,
  ) {}

  /** Decodes a GLB; `inWorker` tells where it ran. */
  async decode(glb: Uint8Array, priority: number, job: DecodeJob): Promise<{ model: unknown; inWorker: boolean }> {
    if (this.workers && this.workersHaveTask) {
      const outcome = await this.runOnWorkers(this.workers, glb.slice().buffer, priority, job);
      if (outcome.ok) return { model: outcome.output, inWorker: true };
      const { code, taskCode, message } = outcome.error;
      if (job.cancelled || code === 'cancelled' || code === 'aborted') throw new DecodeCancelled();
      if (taskCode !== 'unknown-task') throw new Error(`parse-model: ${message}`);
      this.workersHaveTask = false;
    }
    if (this.ownWorker) {
      const model = await this.ownWorker.decode(glb.slice().buffer);
      if (job.cancelled) throw new DecodeCancelled();
      return { model, inWorker: true };
    }
    const task = this.fallback?.['parse-model'];
    if (!task) throw new Error('no parse-model task: the worker program lacks it and no modelTasks were given');
    const output = await task({ bytes: glb.slice().buffer }, { isCancelled: () => job.cancelled });
    if (job.cancelled) throw new DecodeCancelled();
    return { model: output.output, inWorker: false };
  }

  private runOnWorkers(
    workers: WorkerPool,
    buffer: ArrayBuffer,
    priority: number,
    job: DecodeJob,
  ): Promise<WorkerTaskOutcome> {
    return new Promise((resolve) => {
      let id = -1;
      id = workers.run(
        {
          task: 'parse-model',
          input: { bytes: buffer, ...(this.dracoWasmUrl === undefined ? {} : { dracoWasmUrl: this.dracoWasmUrl }) },
          transfer: [buffer],
          priority,
          timeoutMs: 30_000,
        },
        (outcome) => {
          job.tasks.delete(id);
          resolve(outcome);
        },
      );
      job.tasks.add(id);
    });
  }
}
