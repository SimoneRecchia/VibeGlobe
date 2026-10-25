// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
const CAPACITY = 16;

/** The longest window the event cadence may stretch the velocity window to: slower events are not a drag. */
const MAX_WINDOW_MS = 300;

/** Change of a scale or angle channel (log2 of a finger distance, radians) below which a hold counts as still. */
const STILL_CHANNEL_EPSILON = 1e-3;

/**
 * Timestamped samples of up to four channels (for example x, y, log2 of a finger distance, an angle), kept in a ring
 * of preallocated arrays for the velocity at release (ADR 0009 §3 and §6).
 */
export class SampleRing {
  private readonly times = new Float64Array(CAPACITY);
  private readonly values = new Float64Array(CAPACITY * 4);
  private count = 0;
  private head = 0;

  /** Forgets every sample. */
  clear(): void {
    this.count = 0;
  }

  /**
   * Records one sample. One with the same time as the previous replaces it: browsers dispatch the moves of several
   * fingers of one touch event one by one with one timestamp, and only the last shows them all moved.
   */
  add(timeMs: number, a: number, b = 0, c = 0, d = 0): void {
    const previous = (this.head - 1 + CAPACITY) % CAPACITY;
    if (this.count > 0 && this.times[previous] === timeMs) {
      this.head = previous;
      this.count--;
    }
    const i = this.head;
    this.times[i] = timeMs;
    this.values[i * 4] = a;
    this.values[i * 4 + 1] = b;
    this.values[i * 4 + 2] = c;
    this.values[i * 4 + 3] = d;
    this.head = (i + 1) % CAPACITY;
    this.count = Math.min(this.count + 1, CAPACITY);
  }

  /**
   * Velocity per millisecond of each channel at a release at `releaseMs`, written to `out` (KB-177). It is the
   * least-squares slope of the samples within `windowMs` of the latest one, so a flick that slows down before the
   * finger lifts still carries its direction and part of its speed; the window stretches to twice the longest of the
   * last three intervals between samples when events come slower (a busy main thread, a slow device; at most 300 ms),
   * so the drag is still measured (KB-121). The window ends at the latest motion, not at the release: a trackpad sends
   * no events while it slows to a stop, so a release some time after the last move still glides. Zero only when the
   * pointer was held still: its position (channels a and b) stayed within `stillPx` of the latest sample, and the other
   * channels unchanged, for at least `stillMs` (stretched like the window) before the release; or fewer than two
   * samples span at least 4 ms.
   */
  velocity(windowMs: number, out: Float64Array, releaseMs: number, stillMs: number, stillPx: number): void {
    out.fill(0);
    if (this.count < 2) return;
    const last = this.index(0);
    const lastTime = this.times[last] ?? 0;
    // The longest of the last three intervals: one quick pair of events does not hide a slow cadence.
    let cadenceMs = 0;
    for (let n = 1; n <= 3 && n < this.count; n++) {
      cadenceMs = Math.max(cadenceMs, (this.times[this.index(n - 1)] ?? 0) - (this.times[this.index(n)] ?? 0));
    }
    const stretchMs = Math.min(2 * cadenceMs, MAX_WINDOW_MS);
    if (releaseMs - this.stillSinceMs(stillPx) >= Math.max(stillMs, stretchMs)) return;
    windowMs = Math.max(windowMs, stretchMs);
    let n = 1;
    while (n < this.count && lastTime - (this.times[this.index(n)] ?? 0) <= windowMs) n++;
    // Two events in the same millisecond carry no usable velocity.
    if (n < 2 || lastTime - (this.times[this.index(n - 1)] ?? 0) < 4) return;
    // Least squares on times relative to the latest sample: slope = Σ(t − t̄)(v − v̄) / Σ(t − t̄)².
    let meanT = 0;
    for (let k = 0; k < n; k++) meanT += (this.times[this.index(k)] ?? 0) - lastTime;
    meanT /= n;
    let sTT = 0;
    for (let k = 0; k < n; k++) {
      const dt = (this.times[this.index(k)] ?? 0) - lastTime - meanT;
      sTT += dt * dt;
    }
    for (let c = 0; c < 4; c++) {
      let meanV = 0;
      for (let k = 0; k < n; k++) meanV += this.values[this.index(k) * 4 + c] ?? 0;
      meanV /= n;
      let sTV = 0;
      for (let k = 0; k < n; k++) {
        const i = this.index(k);
        sTV += ((this.times[i] ?? 0) - lastTime - meanT) * ((this.values[i * 4 + c] ?? 0) - meanV);
      }
      out[c] = sTV / sTT;
    }
  }

  /** The ring slot of the sample `back` samples before the latest. */
  private index(back: number): number {
    return (this.head - 1 - back + 2 * CAPACITY) % CAPACITY;
  }

  /**
   * Time since which the samples stayed within `stillPx` of the latest one in channels a and b, with channels c and d
   * unchanged (a pinch or twist in place is motion): the start of the hold before a release.
   */
  private stillSinceMs(stillPx: number): number {
    const last = this.index(0);
    const x = this.values[last * 4] ?? 0;
    const y = this.values[last * 4 + 1] ?? 0;
    const c = this.values[last * 4 + 2] ?? 0;
    const d = this.values[last * 4 + 3] ?? 0;
    let since = this.times[last] ?? 0;
    for (let n = 1; n < this.count; n++) {
      const i = this.index(n);
      const far = Math.hypot((this.values[i * 4] ?? 0) - x, (this.values[i * 4 + 1] ?? 0) - y) >= stillPx;
      const changed =
        Math.abs((this.values[i * 4 + 2] ?? 0) - c) > STILL_CHANNEL_EPSILON ||
        Math.abs((this.values[i * 4 + 3] ?? 0) - d) > STILL_CHANNEL_EPSILON;
      if (far || changed) break;
      since = this.times[i] ?? since;
    }
    return since;
  }
}
