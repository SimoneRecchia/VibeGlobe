// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { TaskOutput, TaskTable } from '@vibeglobe/core';
import { parseGeoJson } from './geojson.js';
import { parseGpx } from './gpx.js';
import { parseKml } from './kml.js';
import { decodeMvt } from './mvt.js';

/** The input of every vector task: the document or tile as bytes (transferred) or as text. */
export interface VectorTaskInput {
  readonly bytes?: ArrayBuffer;
  readonly text?: string;
}

function source(input: unknown): string | ArrayBuffer {
  const value = input as VectorTaskInput | null;
  if (value?.bytes instanceof ArrayBuffer) return value.bytes;
  if (typeof value?.text === 'string') return value.text;
  throw Object.assign(new Error('a vector task needs `bytes` or `text`'), { code: 'invalid-input' });
}

function output(value: unknown, transfer: readonly object[] = []): TaskOutput {
  return { output: value, transfer };
}

/**
 * The worker tasks of the vector adapters (ADR 0011): `decode-mvt` (a tile, or `undefined` for no data),
 * `parse-geojson`, `parse-kml` (KMZ archives included; their files are transferred back) and `parse-gpx`. Every
 * parser treats its input as untrusted and reports problems in its result. The engine's worker program registers
 * this table next to its own tasks, so parsing never runs on the main thread.
 */
export const VECTOR_TASKS: TaskTable = Object.freeze({
  'decode-mvt': (input: unknown) => {
    const bytes = source(input);
    return output(decodeMvt(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes));
  },
  'parse-geojson': (input: unknown) => output(parseGeoJson(source(input))),
  'parse-kml': (input: unknown) => {
    const parsed = parseKml(source(input));
    return output(parsed, [...new Set(Object.values(parsed.resources).map((file) => file.buffer))]);
  },
  'parse-gpx': (input: unknown) => output(parseGpx(source(input))),
});
