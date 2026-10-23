const CAPACITY = 16;

/** The longest window the event cadence may stretch the velocity window to: slower events are not a drag. */
const MAX_WINDOW_MS = 300;

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
   * Velocity per millisecond of each channel over the samples within the window of the latest one, written to `out`,
   * for a release at `releaseMs`. The window is `windowMs`, stretched to twice the longest of the last three intervals
   * between samples when events come slower (a busy main thread, a slow device; at most 300 ms), so the drag is still
   * measured (KB-121). A release more than the window after the latest sample, or fewer than two samples in it, give
   * zero: a release after holding still does not coast. The window ends at the latest motion, not at the release.
   */
  velocity(windowMs: number, out: Float64Array, releaseMs: number): void {
    out.fill(0);
    if (this.count < 2) return;
    const last = (this.head - 1 + CAPACITY) % CAPACITY;
    const lastTime = this.times[last] ?? 0;
    // The longest of the last three intervals: one quick pair of events does not hide a slow cadence.
    let cadenceMs = 0;
    for (let n = 1; n <= 3 && n < this.count; n++) {
      const newer = this.times[(last - n + 1 + CAPACITY) % CAPACITY] ?? 0;
      cadenceMs = Math.max(cadenceMs, newer - (this.times[(last - n + CAPACITY) % CAPACITY] ?? 0));
    }
    windowMs = Math.max(windowMs, Math.min(2 * cadenceMs, MAX_WINDOW_MS));
    if (releaseMs - lastTime > windowMs) return;
    let first = last;
    for (let n = 1; n < this.count; n++) {
      const i = (last - n + CAPACITY) % CAPACITY;
      if (lastTime - (this.times[i] ?? 0) > windowMs) break;
      first = i;
    }
    const dt = lastTime - (this.times[first] ?? 0);
    // Two events in the same millisecond carry no usable velocity.
    if (first === last || dt < 4) return;
    for (let c = 0; c < 4; c++) out[c] = ((this.values[last * 4 + c] ?? 0) - (this.values[first * 4 + c] ?? 0)) / dt;
  }
}
