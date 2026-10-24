// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Rolling frame-time statistics over the most recent frames.
 *
 * Recording a frame allocates nothing, so it is safe to call from the per-frame loop.
 */
export class FrameStats {
  private readonly frameTimesMs: Float64Array;
  private count = 0;
  private nextIndex = 0;
  private sumMs = 0;
  private previousTimestampMs: number | undefined;

  /** @param capacity - Number of most recent frames the statistics cover. */
  constructor(capacity = 120) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
    this.frameTimesMs = new Float64Array(capacity);
  }

  /** Records a frame presented at `timestampMs` (for example the `requestAnimationFrame` timestamp). */
  recordFrame(timestampMs: number): void {
    const previous = this.previousTimestampMs;
    this.previousTimestampMs = timestampMs;
    if (previous === undefined || timestampMs < previous) return;
    const frameTimeMs = timestampMs - previous;
    if (this.count === this.frameTimesMs.length) this.sumMs -= this.frameTimesMs[this.nextIndex] ?? 0;
    else this.count++;
    this.frameTimesMs[this.nextIndex] = frameTimeMs;
    this.sumMs += frameTimeMs;
    this.nextIndex = (this.nextIndex + 1) % this.frameTimesMs.length;
  }

  /** Time between the last two recorded frames in milliseconds, or `undefined` before two frames. */
  get lastFrameTimeMs(): number | undefined {
    if (this.count === 0) return undefined;
    const lastIndex = (this.nextIndex + this.frameTimesMs.length - 1) % this.frameTimesMs.length;
    return this.frameTimesMs[lastIndex];
  }

  /** Mean frame time over the window in milliseconds, or `undefined` before two frames. */
  get meanFrameTimeMs(): number | undefined {
    return this.count === 0 ? undefined : this.sumMs / this.count;
  }

  /** Frames per second derived from the mean frame time, or `undefined` before two frames. */
  get framesPerSecond(): number | undefined {
    const mean = this.meanFrameTimeMs;
    return mean === undefined || mean === 0 ? undefined : 1000 / mean;
  }

  /** Forgets every recorded frame, for example after the loop was paused. */
  reset(): void {
    this.count = 0;
    this.nextIndex = 0;
    this.sumMs = 0;
    this.previousTimestampMs = undefined;
  }
}
