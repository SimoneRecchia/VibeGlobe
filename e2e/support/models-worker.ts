// A module worker that runs @vibeglobe/models' `parse-model` task, for the test that models decode off the main
// thread with Draco and meshopt (F361). The engine's worker program registers the same table once hook request 1 of
// the models and quality track lands (docs/parallel-tracks.md).
import { createModelTasks, loadDraco3d, PARSE_MODEL_TASK } from '@vibeglobe/models';

interface Scope {
  onmessage: ((event: MessageEvent<{ dracoWasmUrl: string; input: unknown }>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as Scope;
scope.onmessage = async (event) => {
  // Only a worker has no document and a WorkerGlobalScope.
  const inWorker = typeof document === 'undefined' && 'WorkerGlobalScope' in globalThis;
  try {
    const tasks = createModelTasks({ draco: loadDraco3d(event.data.dracoWasmUrl) });
    const result = await tasks[PARSE_MODEL_TASK]?.(event.data.input, { isCancelled: () => false });
    scope.postMessage({ inWorker, output: result?.output }, (result?.transfer ?? []) as Transferable[]);
  } catch (error) {
    scope.postMessage({ inWorker, error: { code: (error as { code?: string }).code, message: String(error) } });
  }
};
