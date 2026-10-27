// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** Counters of the imagery streaming of one engine instance (`Globe.imageryStats()`). */
export interface ImageryStats {
  /** Tiles waiting for a request slot, in flight, being decoded, on the GPU, failed, without data. */
  readonly queued: number;
  readonly loading: number;
  readonly decoding: number;
  readonly ready: number;
  readonly failed: number;
  readonly noData: number;
  /** Requests started so far. */
  readonly requested: number;
  /** Texture uploads so far, and the time and bytes the last frame spent uploading (F101, F102). */
  readonly uploads: number;
  readonly uploadMsLastFrame: number;
  readonly uploadBytesLastFrame: number;
  /** Decoded tiles still waiting for their upload after the last frame. */
  readonly uploadsPending: number;
  /** Pinned base tiles resident (or without data) and in all (F084). */
  readonly pinnedSettled: number;
  readonly pinnedTotal: number;
  /** GPU and RAM usage and budgets, in bytes (F098). */
  readonly gpuBytes: number;
  readonly gpuBudgetBytes: number;
  readonly ramBytes: number;
  readonly ramBudgetBytes: number;
  /** Tiles found and not found in the RAM tier (F097). */
  readonly ramHits: number;
  readonly ramMisses: number;
  /** GPU evictions, and uploads refused because nothing could be evicted. */
  readonly evicted: number;
  readonly refused: number;
  /** Throughput measured from the page's tile downloads, bits per second; NaN until measured (F300). */
  readonly bandwidthBitsPerSecond: number;
  /** The shortest recent wait for a response's headers, milliseconds; NaN until measured (F303). */
  readonly latencyMs: number;
}
