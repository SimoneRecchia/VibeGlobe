const TIME = 0;
const DELTA = 1;
const LAST = 2;
const MANUAL = 3;
const PREVIOUS_TIME = 4;
/** The longest step one frame may advance (architecture §2): a stall or a hidden tab never produces a jump. */
const MAX_STEP_MS = 100;

/**
 * Engine time, which animations, fades and inertia run on (ADR 0009: pure functions of engine-clock time). It advances
 * by the display frame's timestamp step, clamped to 100 ms, so motion follows the same path at every refresh rate and
 * after stalls. With a manual step (tests, ADR 0012 Determinism) every drawn frame advances it by exactly that much.
 * Every time, the manual step included, stays in one typed array: a double merged with a small-integer field in the
 * same variable is boxed by V8's mid-tier compiler on every call (ADR 0018).
 */
export class EngineClock {
  /** Engine time, last step, last timestamp, manual step and the time before the last step, in milliseconds. */
  private readonly state = Float64Array.of(0, 0, -1, 0, 0);

  constructor(manualStepMs = 0) {
    this.state[MANUAL] = manualStepMs;
  }

  /** Engine time in milliseconds since the first frame. */
  get timeMs(): number {
    return this.state[TIME] ?? 0;
  }

  /** The last frame's step in milliseconds. */
  get deltaMs(): number {
    return this.state[DELTA] ?? 0;
  }

  /** Advances to the frame whose timestamp is `timestamp[0]` (milliseconds, any origin). */
  advance(timestamp: Float64Array): void {
    const state = this.state;
    const now = timestamp[0] ?? 0;
    const last = state[LAST] ?? -1;
    const manual = state[MANUAL] ?? 0;
    // Comparisons, not Math.min/max: V8's mid tier calls them with boxed doubles (ADR 0018).
    let step = now - last;
    if (manual > 0) step = manual;
    else if (last < 0 || step < 0) step = 0;
    else if (step > MAX_STEP_MS) step = MAX_STEP_MS;
    state[LAST] = now;
    state[DELTA] = step;
    state[PREVIOUS_TIME] = state[TIME] ?? 0;
    state[TIME] = (state[TIME] ?? 0) + step;
  }

  /** The frame just advanced was not drawn: in manual mode its step is taken back, one step per drawn frame (KB-058). */
  skipped(): void {
    const state = this.state;
    const manual = state[MANUAL] ?? 0;
    if (manual > 0) {
      // Restored, not subtracted: (t + step) − step is not always t in floating point (KB-060).
      state[TIME] = state[PREVIOUS_TIME] ?? 0;
      state[DELTA] = 0;
    }
  }
}
