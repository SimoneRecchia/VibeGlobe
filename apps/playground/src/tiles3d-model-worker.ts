// The 3D Tiles scenarios' own model worker (development server only, `tiles3d-dev-decoding.ts`): runs
// @vibeglobe/models' `parse-model` off the main thread until the engine's worker program registers it (hook request
// E (1)). Each decode is measured as `vibeglobe:parse-model` in this worker's timeline (F463).
import { createModelTasks, loadDraco3d, PARSE_MODEL_TASK, type ParseModelTaskInput } from '@vibeglobe/models';

interface Request {
  readonly id: number;
  readonly dracoWasmUrl: string;
  readonly input: ParseModelTaskInput;
}

interface Scope {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as Scope;
let tasks: ReturnType<typeof createModelTasks> | undefined;
scope.onmessage = async (event) => {
  const { id, dracoWasmUrl, input } = event.data;
  tasks ??= createModelTasks({ draco: loadDraco3d(dracoWasmUrl) });
  const start = performance.now();
  try {
    const result = await tasks[PARSE_MODEL_TASK]?.(input, { isCancelled: () => false });
    performance.measure('vibeglobe:parse-model', { start, end: performance.now() });
    scope.postMessage({ id, model: result?.output }, (result?.transfer ?? []) as Transferable[]);
  } catch (error) {
    scope.postMessage({ id, error: String(error) });
  }
};
