/**
 * Every built-in task by name: the table the worker program registers, and the one the inline executor loads lazily
 * after repeated worker start failures (ADR 0011 rule 6). Later increments add tasks from `sources` and `layers`.
 */
import { decodeImage } from './decode-image.js';
import { decodeTerrain } from './decode-terrain.js';
import type { TaskFunction, TaskTable } from './protocol.js';
import { transcodeKtx2 } from './transcode-ktx2.js';

let vectorTasks: Promise<TaskTable> | undefined;
let clusterTasks: Promise<TaskTable> | undefined;

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
});
