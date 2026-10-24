// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Worker program of data-layer label glyphs (F358, ADR 0045): turns a label's rasterized coverage into its signed
 * distance field off the main thread. Only {@link LabelSdf} loads this module, as a worker.
 */
import { sdfFromCoverage } from './vector-tiles/local-glyphs.js';

/** A coverage to turn into a distance field: RGBA bytes, `width` × `height`. */
export interface SdfRequest {
  readonly key: string;
  readonly coverage: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** The distance field of a request: one byte per texel. */
export interface SdfReply {
  readonly key: string;
  readonly bitmap: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** The part of the dedicated worker scope this module uses (the package compiles against the DOM library). */
interface WorkerScope {
  onmessage: ((event: MessageEvent<SdfRequest>) => void) | null;
  postMessage(message: SdfReply, transfer: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;
scope.onmessage = (event) => {
  const { key, coverage, width, height } = event.data;
  const bitmap = Uint8Array.from(sdfFromCoverage(coverage, width, height));
  scope.postMessage({ key, bitmap, width, height }, [bitmap.buffer]);
};
