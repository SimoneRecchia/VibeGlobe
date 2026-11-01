// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Every built-in task by name: the table the worker program registers, and the one the inline executor loads lazily
 * after repeated worker start failures (ADR 0011 rule 6). The basic program registers `BASIC_TASKS` alone (ADR 0172).
 */
import { BASIC_TASKS } from './basic-tasks.js';
import { lazyTable } from './lazy-task.js';
import type { TaskTable } from './protocol.js';
import { compileWasm } from './wasm.js';

/** meshoptimizer's decoder module, shipped next to the worker program without its JavaScript (F100). */
const MESHOPT_URL = new URL('../wasm/meshopt-decoder.wasm', import.meta.url);

/** A clustering task of `@vibeglobe/layers` (F373), loaded like the vector tasks on the first one. */
const clusterTask = lazyTable('cluster', () =>
  import('@vibeglobe/layers/cluster-worker').then((module) => module.CLUSTER_TASKS),
);

/** The built-in tasks: the basic ones and those of `@vibeglobe/layers` and `@vibeglobe/models` (ADR 0172). */
export const TASKS: TaskTable = Object.freeze({
  ...BASIC_TASKS,
  ...Object.fromEntries(
    ['load', 'items', 'expansion', 'leaves', 'destroy'].map((name) => [
      `cluster-${name}`,
      clusterTask(`cluster-${name}`),
    ]),
  ),
  'layout-vector-tile': lazyTable('vector-tile', () =>
    import('@vibeglobe/layers/vector-tiles').then((module) => module.VECTOR_TILE_TASKS),
  )('layout-vector-tile'),
  // Draco and meshopt decode in the task: meshopt through the module above, Draco from the input's `dracoWasmUrl`.
  'parse-model': lazyTable('models', () =>
    import('@vibeglobe/models').then((module) =>
      module.createModelTasks({ meshopt: module.meshoptWasmDecoder(() => compileWasm(MESHOPT_URL)) }),
    ),
  )('parse-model'),
});
