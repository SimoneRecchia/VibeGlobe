// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The upload cost model of ADR 0007 §Uploads and ADR 0020 §5: predicts how long a GPU upload takes from its size, so the
 * upload queue can stay within its per-frame time budget. One instance per renderer backend (WebGPU and WebGL2 differ),
 * with separate averages for uncompressed uploads, which also pay a GPU mipmap pass, and compressed ones, which do not.
 *
 * The model averages milliseconds per byte rather than bytes per millisecond: the prediction is then a product, and a
 * sample of 0 ms (browsers coarsen `performance.now()` to 0.1 ms or more) stays finite.
 */

/** Index of the uncompressed (RGBA8 with GPU mipmaps) average in {@link UploadCostModel.msPerByte}. */
export const UNCOMPRESSED_UPLOAD = 0;
/** Index of the block-compressed average in {@link UploadCostModel.msPerByte}. */
export const COMPRESSED_UPLOAD = 1;

const BYTES_PER_MIB = 1024 * 1024;

/**
 * Seed for uncompressed uploads: 2 ms per MiB (0.5 GiB/s). Conservative on purpose: a 256 px tile with its mip chain
 * (349,524 bytes) predicts 0.67 ms, so a 2 ms frame starts with 3 uploads until measurements arrive.
 */
export const DEFAULT_UNCOMPRESSED_MS_PER_BYTE = 2 / BYTES_PER_MIB;
/** Seed for compressed uploads: 1 ms per MiB; no mipmap pass, plain copies of the transcoded levels. */
export const DEFAULT_COMPRESSED_MS_PER_BYTE = 1 / BYTES_PER_MIB;
/** Weight of a new sample in the moving average once warmed up. */
export const DEFAULT_UPLOAD_COST_SMOOTHING = 0.1;
/**
 * A sample enters the average clamped to this factor above or below the current estimate, so a one-off stall (a
 * collection, a pipeline compile inside the upload) or a 0 ms reading from a coarse clock moves it by a bounded step.
 */
export const DEFAULT_UPLOAD_COST_OUTLIER_FACTOR = 8;

/** Settings of an {@link UploadCostModel}. */
export interface UploadCostOptions {
  /** Starting estimate for uncompressed uploads, in milliseconds per byte. */
  uncompressedMsPerByte?: number;
  /** Starting estimate for compressed uploads, in milliseconds per byte. */
  compressedMsPerByte?: number;
  /** Weight of a new sample once warmed up, in (0, 1]. */
  smoothing?: number;
  /** Clamp factor for samples relative to the current estimate, at least 1. */
  outlierFactor?: number;
}

function checkPositive(value: number, name: string): void {
  if (!(value > 0) || value === Infinity)
    throw new RangeError(`${name} must be a positive finite number, got ${value}`);
}

/**
 * Exponentially weighted moving average of upload milliseconds per byte, kept for uncompressed and compressed uploads.
 * The seed counts as one sample, so the first measurements are averaged with weights 1/2, 1/3, … until the weight
 * reaches `smoothing`: the model leaves a wrong seed within a few uploads, yet one sample cannot replace it alone.
 */
export class UploadCostModel {
  /**
   * The current estimates in milliseconds per byte, indexed by {@link UNCOMPRESSED_UPLOAD} and
   * {@link COMPRESSED_UPLOAD}. Per-frame code reads them here and multiplies by the bytes, so no double crosses a
   * call boundary (ADR 0018); write them only through {@link UploadCostModel.record}.
   */
  readonly msPerByte = new Float64Array(2);
  /** Samples recorded per kind. */
  private readonly samples = new Float64Array(2);
  private readonly single = new Float64Array(1);
  private readonly smoothing: number;
  private readonly outlierFactor: number;

  constructor(options: UploadCostOptions = {}) {
    const uncompressed = options.uncompressedMsPerByte ?? DEFAULT_UNCOMPRESSED_MS_PER_BYTE;
    const compressed = options.compressedMsPerByte ?? DEFAULT_COMPRESSED_MS_PER_BYTE;
    this.smoothing = options.smoothing ?? DEFAULT_UPLOAD_COST_SMOOTHING;
    this.outlierFactor = options.outlierFactor ?? DEFAULT_UPLOAD_COST_OUTLIER_FACTOR;
    checkPositive(uncompressed, 'uncompressedMsPerByte');
    checkPositive(compressed, 'compressedMsPerByte');
    checkPositive(this.smoothing, 'smoothing');
    if (this.smoothing > 1) throw new RangeError(`smoothing must be at most 1, got ${this.smoothing}`);
    if (!(this.outlierFactor >= 1) || this.outlierFactor === Infinity) {
      throw new RangeError(`outlierFactor must be a finite number of at least 1, got ${this.outlierFactor}`);
    }
    this.msPerByte[UNCOMPRESSED_UPLOAD] = uncompressed;
    this.msPerByte[COMPRESSED_UPLOAD] = compressed;
  }

  /** Predicted milliseconds to upload `bytes` (outside the frame loop: the result is a boxed double). */
  predictMs(bytes: number, compressed: boolean): number {
    return bytes * (this.msPerByte[compressed ? COMPRESSED_UPLOAD : UNCOMPRESSED_UPLOAD] ?? 0);
  }

  /** Number of samples recorded for a kind. */
  sampleCount(compressed: boolean): number {
    return this.samples[compressed ? COMPRESSED_UPLOAD : UNCOMPRESSED_UPLOAD] ?? 0;
  }

  /** Records an upload of `bytes` that took `ms` milliseconds (outside the frame loop: `ms` may be boxed). */
  record(bytes: number, ms: number, compressed: boolean): void {
    this.single[0] = ms;
    this.recordAt(bytes, this.single, 0, compressed);
  }

  /**
   * Records an upload of `bytes` that took `durationsMs[at]` milliseconds; the frame-loop form, since the duration
   * stays in an array. Samples with no bytes, or a negative or non-finite duration, are ignored.
   */
  recordAt(bytes: number, durationsMs: ArrayLike<number>, at: number, compressed: boolean): void {
    const ms = durationsMs[at] ?? -1;
    if (!(bytes > 0) || !(ms >= 0) || ms === Infinity) return;
    const kind = compressed ? COMPRESSED_UPLOAD : UNCOMPRESSED_UPLOAD;
    const estimate = this.msPerByte[kind] ?? 0;
    let sample = ms / bytes;
    const high = estimate * this.outlierFactor;
    const low = estimate / this.outlierFactor;
    if (sample > high) sample = high;
    else if (sample < low) sample = low;
    const count = (this.samples[kind] ?? 0) + 1;
    this.samples[kind] = count;
    const warmUp = 1 / (count + 1);
    const weight = warmUp > this.smoothing ? warmUp : this.smoothing;
    this.msPerByte[kind] = estimate + (sample - estimate) * weight;
  }
}
