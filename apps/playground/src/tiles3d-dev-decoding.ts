/**
 * The 3D Tiles scenarios' model decoding on the development server (F463): a module worker of the scenario's own
 * running `parse-model` (`tiles3d-model-worker.ts`), until the engine's worker program registers the task (hook
 * request E (1)). Development only: the worker bundles meshoptimizer's decoder, whose Blob-worker code production
 * bundles refuse (F100).
 */
import type { ModelWorker } from '@vibeglobe/sources/tiles3d';

/** A model worker whose Draco decoder loads from `dracoWasmUrl`. */
export function devModelWorker(dracoWasmUrl: string): ModelWorker {
  const worker = new Worker(new URL('./tiles3d-model-worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, { resolve(model: unknown): void; reject(error: Error): void }>();
  let next = 1;
  worker.onmessage = (event: MessageEvent<{ id: number; model?: unknown; error?: string }>) => {
    const request = pending.get(event.data.id);
    pending.delete(event.data.id);
    if (event.data.error !== undefined) request?.reject(new Error(event.data.error));
    else request?.resolve(event.data.model);
  };
  return {
    decode(bytes) {
      const id = next++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, dracoWasmUrl, input: { bytes } }, [bytes]);
      });
    },
  };
}
