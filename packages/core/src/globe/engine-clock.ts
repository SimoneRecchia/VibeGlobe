const TIME = 0;
const DELTA = 1;
const LAST = 2;
/** The longest step one frame may advance (architecture §2): a stall or a hidden tab never produces a jump. */
const MAX_STEP_MS = 100;

/**
 * Engine time, which animations, fades and inertia run on (ADR 0009: pure functions of engine-clock time). It advances
 * by the display frame's timestamp step, clamped to 100 ms, so motion follows the same path at every refresh rate and
 * after stalls. With a manual step (tests, ADR 0012 Determinism) every drawn frame advances it by exactly that much.
 * Times stay in a typed array, so the frame loop never boxes them (ADR 0018).
 */
export class EngineClock {
  /** Engine time, last step and last timestamp, in milliseconds. */
  private readonly state = Float64Array.of(0, 0, -1);

  constructor(private readonly manualStepMs = 0) {}

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
    let step = this.manualStepMs;
    if (step <= 0) {
      step = last < 0 ? 0 : now - last;
      // Comparisons, not Math.min/max: V8's mid tier calls them with boxed doubles (ADR 0018).
      if (step < 0) step = 0;
      else if (step > MAX_STEP_MS) step = MAX_STEP_MS;
    }
    state[LAST] = now;
    state[DELTA] = step;
    state[TIME] = (state[TIME] ?? 0) + step;
  }
}
