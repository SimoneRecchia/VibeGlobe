// A module worker that runs the vector adapters' worker tasks, for the test that parsing happens off the main thread
// (F236–F239). The engine's own worker program registers the same table (docs/internal/parallel-tracks.md).
import { VECTOR_TASKS } from '@vibeglobe/sources/vector';

interface Scope {
  onmessage: ((event: MessageEvent<{ task: string; input: unknown }>) => void) | null;
  postMessage(message: unknown): void;
}

const scope = globalThis as unknown as Scope;
scope.onmessage = async (event) => {
  const run = VECTOR_TASKS[event.data.task];
  const result = await run?.(event.data.input, { isCancelled: () => false });
  // Only a worker has no document and a WorkerGlobalScope.
  const inWorker = typeof document === 'undefined' && 'WorkerGlobalScope' in globalThis;
  scope.postMessage({ inWorker, output: result?.output });
};
