// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The tasks of the basic worker program (ADR 0172): image, terrain and KTX2 decoding and the vector parsers of
 * `@vibeglobe/sources`, everything an application with imagery and terrain needs. It imports nothing from
 * `@vibeglobe/layers` or `@vibeglobe/models`, so an application can use the worker without installing them.
 */
import { decodeImage } from './decode-image.js';
import { decodeTerrain } from './decode-terrain.js';
import type { TaskFunction, TaskTable } from './protocol.js';
import { transcodeKtx2 } from './transcode-ktx2.js';

let vectorTasks: Promise<TaskTable> | undefined;

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

/** The basic tasks. */
export const BASIC_TASKS: TaskTable = Object.freeze({
  'decode-image': decodeImage,
  'decode-terrain': decodeTerrain,
  'transcode-ktx2': transcodeKtx2,
  'parse-geojson': vectorTask('parse-geojson'),
  'parse-kml': vectorTask('parse-kml'),
  'parse-gpx': vectorTask('parse-gpx'),
  'decode-mvt': vectorTask('decode-mvt'),
});
