/**
 * Every built-in task by name: the table the worker program registers, and the one the inline executor loads lazily
 * after repeated worker start failures (ADR 0011 rule 6). Later increments add tasks from `sources` and `layers`.
 */
import { decodeImage } from './decode-image.js';
import { decodeTerrain } from './decode-terrain.js';
import type { TaskFunction, TaskTable } from './protocol.js';
import { transcodeKtx2 } from './transcode-ktx2.js';
import { compileWasm } from './wasm.js';

/** meshoptimizer's decoder module, shipped next to the worker program without its JavaScript (F100). */
const MESHOPT_URL = new URL('../wasm/meshopt-decoder.wasm', import.meta.url);

let vectorTasks: Promise<TaskTable> | undefined;
let clusterTasks: Promise<TaskTable> | undefined;
const lazyTables = new Map<string, Promise<TaskTable>>();

/**
 * A vector task of `@vibeglobe/sources/vector` (F371, M13): the parsers load on the first such task, in their own
 * chunk, so workers that only decode imagery never load them.
 */
function vectorTask(name: string): TaskFunction {
  return async (input, context) => {
    vectorTasks ??= import('@vibeglobe/sources/vector').then((module) => module.VECTOR_TASKS);
    const task = (await vectorTasks)[name];
    if (!task) throw Object.assign(new Error(`no vector task ${name}`), { code: 'unknown-task' });
    return task(input, context);
  };
}

/** A clustering task of `@vibeglobe/layers` (F373), loaded like the vector tasks on the first one. */
function clusterTask(name: string): TaskFunction {
  return async (input, context) => {
    clusterTasks ??= import('@vibeglobe/layers/cluster-worker').then((module) => module.CLUSTER_TASKS);
    const task = (await clusterTasks)[name];
    if (!task) throw Object.assign(new Error(`no cluster task ${name}`), { code: 'unknown-task' });
    return task(input, context);
  };
}

/**
 * A task of a table another package provides, imported on its first use in its own chunk: vector-tile layout of
 * `@vibeglobe/layers/vector-tiles` (M13), glTF parsing of `@vibeglobe/models` (F361, M13).
 */
function lazyTask(table: string, load: () => Promise<TaskTable>, name: string): TaskFunction {
  return async (input, context) => {
    let tasks = lazyTables.get(table);
    if (!tasks) lazyTables.set(table, (tasks = load()));
    const task = (await tasks)[name];
    if (!task) throw Object.assign(new Error(`no ${table} task ${name}`), { code: 'unknown-task' });
    return task(input, context);
  };
}

/** The built-in tasks. */
export const TASKS: TaskTable = Object.freeze({
  'decode-image': decodeImage,
  'decode-terrain': decodeTerrain,
  'transcode-ktx2': transcodeKtx2,
  'parse-geojson': vectorTask('parse-geojson'),
  'parse-kml': vectorTask('parse-kml'),
  'parse-gpx': vectorTask('parse-gpx'),
  'decode-mvt': vectorTask('decode-mvt'),
  'cluster-load': clusterTask('cluster-load'),
  'cluster-items': clusterTask('cluster-items'),
  'cluster-expansion': clusterTask('cluster-expansion'),
  'cluster-leaves': clusterTask('cluster-leaves'),
  'cluster-destroy': clusterTask('cluster-destroy'),
  'layout-vector-tile': lazyTask(
    'vector-tile',
    () => import('@vibeglobe/layers/vector-tiles').then((module) => module.VECTOR_TILE_TASKS),
    'layout-vector-tile',
  ),
  // Draco and meshopt decode in the task: meshopt through the module above, Draco from the input's `dracoWasmUrl`.
  'parse-model': lazyTask(
    'models',
    () =>
      import('@vibeglobe/models').then((module) =>
        module.createModelTasks({ meshopt: module.meshoptWasmDecoder(() => compileWasm(MESHOPT_URL)) }),
      ),
    'parse-model',
  ),
});
