// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The tasks of the basic worker program (ADR 0172): image, terrain and KTX2 decoding and the vector parsers of
 * `@vibeglobe/sources`, everything an application with imagery and terrain needs. It imports nothing from
 * `@vibeglobe/layers` or `@vibeglobe/models`, so an application can use the worker without installing them.
 */
import { decodeImage } from './decode-image.js';
import { decodeTerrain } from './decode-terrain.js';
import { lazyTable } from './lazy-task.js';
import type { TaskTable } from './protocol.js';

/**
 * A vector task of `@vibeglobe/sources/vector` (F371, M13): the parsers load on the first such task, in their own
 * chunk, so workers that only decode imagery never load them.
 */
const vectorTask = lazyTable('vector', () => import('@vibeglobe/sources/vector').then((module) => module.VECTOR_TASKS));

/** The basic tasks. */
export const BASIC_TASKS: TaskTable = Object.freeze({
  'decode-image': decodeImage,
  'decode-terrain': decodeTerrain,
  // Its JavaScript loads with the first KTX2 tile, as its WebAssembly does (KB-296).
  'transcode-ktx2': lazyTable('ktx2', () =>
    import('./transcode-ktx2.js').then((module) => ({ 'transcode-ktx2': module.transcodeKtx2 })),
  )('transcode-ktx2'),
  'parse-geojson': vectorTask('parse-geojson'),
  'parse-kml': vectorTask('parse-kml'),
  'parse-gpx': vectorTask('parse-gpx'),
  'decode-mvt': vectorTask('decode-mvt'),
});
