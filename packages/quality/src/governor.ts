/** Options of the frame-time governor (F401, F402); every time is in milliseconds. */
export interface GovernorOptions {
  /** Frame time the governor keeps, ms (default 1000 / 60). */
  readonly targetFrameMs?: number;
  /** Frames whose median the governor judges (default 30): one slow frame never lowers quality. */
  readonly windowFrames?: number;
  /** Lower when the median exceeds the target by this factor (default 1.15). */
  readonly lowerAbove?: number;
  /** Raise only while the median stays under the target times this factor (default 0.75): the dead band between. */
  readonly raiseBelow?: number;
  /** How long the median must stay over the threshold before lowering (default 500). */
  readonly reactionMs?: number;
  /** How long the median must stay under the raise threshold before raising one step (default 3000). */
  readonly stableMs?: number;
  /** Shortest time between two changes of level, in either direction (default 2000). */
  readonly minChangeIntervalMs?: number;
  /**
   * A gap between frames longer than this (the engine idled, the tab was hidden) restarts the measurement instead of
   * counting as a slow frame (default 250).
   */
  readonly idleGapMs?: number;
}

/** The documented defaults of {@link GovernorOptions}. */
export const GOVERNOR_DEFAULTS: Readonly<Required<GovernorOptions>> = Object.freeze({
  targetFrameMs: 1000 / 60,
  windowFrames: 30,
  lowerAbove: 1.15,
  raiseBelow: 0.75,
  reactionMs: 500,
  stableMs: 3000,
  minChangeIntervalMs: 2000,
  idleGapMs: 250,
});

/** A change of level the governor decided. */
export interface GovernorDecision {
  /** The new level: 0 is the preset, higher is cheaper. */
  readonly level: number;
  readonly direction: 'lower' | 'raise';
  /** The median frame time that triggered it. */
  readonly medianMs: number;
}

/**
 * Watches frame times and decides when to step quality down or up (F401, F402). Hysteresis comes from four parts:
 * a median over a window (spikes do not count), a dead band between the lowering and raising thresholds, timers
 * (lower after `reactionMs` over, raise after `stableMs` under) and a minimum interval between changes. A raise
 * undone by the next lowering (back to the level it left) doubles the next raise's wait (up to 8×), so a load hovering at
 * the threshold settles instead of oscillating.
 */
export class FrameTimeGovernor {
  private readonly options: Required<GovernorOptions>;
  private readonly samples: Float64Array;
  private readonly sorted: Float64Array;
  private count = 0;
  private next = 0;
  private lastFrameAtMs: number | undefined;
  private overSinceMs: number | undefined;
  private underSinceMs: number | undefined;
  private lastChangeAtMs = -Infinity;
  private lastRaiseAtMs = -Infinity;
  /** The level the last raise left, until another lowering: lowering back to it undoes the raise. */
  private raisedFrom: number | undefined;
  private raiseBackoff = 1;
  private currentLevel = 0;

  constructor(
    /** Number of levels: 0 to `levels - 1`. */
    private readonly levels: number,
    options: GovernorOptions = {},
  ) {
    this.options = { ...GOVERNOR_DEFAULTS, ...options };
    this.samples = new Float64Array(this.options.windowFrames);
    this.sorted = new Float64Array(this.options.windowFrames);
  }

  /** The current level. */
  get level(): number {
    return this.currentLevel;
  }

  /** The wait before the next raise, ms: `stableMs` times the backoff. */
  get raiseWaitMs(): number {
    return this.options.stableMs * this.raiseBackoff;
  }

  /** Sets the level (a preset switch starts at 0) and restarts the measurement. */
  reset(level = 0, nowMs?: number): void {
    this.currentLevel = Math.min(Math.max(level, 0), this.levels - 1);
    this.restart();
    if (nowMs !== undefined) this.lastChangeAtMs = nowMs;
  }

  private restart(): void {
    this.count = 0;
    this.next = 0;
    this.lastFrameAtMs = undefined;
    this.overSinceMs = undefined;
    this.underSinceMs = undefined;
  }

  /** The median of the window, or NaN before it is full. */
  median(): number {
    if (this.count < this.samples.length) return NaN;
    this.sorted.set(this.samples);
    this.sorted.sort();
    const mid = this.sorted.length >> 1;
    return this.sorted.length % 2
      ? (this.sorted[mid] ?? NaN)
      : ((this.sorted[mid - 1] ?? 0) + (this.sorted[mid] ?? 0)) / 2;
  }

  /**
   * Records a drawn frame at `nowMs` (the frame's interval is the time since the previous one, or `frameMs` when the
   * caller measures it) and returns a decision when the level changes, else `undefined`. Allocates nothing.
   */
  frame(nowMs: number, frameMs?: number): GovernorDecision | undefined {
    const previous = this.lastFrameAtMs;
    this.lastFrameAtMs = nowMs;
    const interval = frameMs ?? (previous === undefined ? undefined : nowMs - previous);
    if (interval === undefined) return undefined;
    if (frameMs === undefined && interval > this.options.idleGapMs) {
      this.restart();
      this.lastFrameAtMs = nowMs;
      return undefined;
    }
    this.samples[this.next] = interval;
    this.next = (this.next + 1) % this.samples.length;
    this.count = Math.min(this.count + 1, this.samples.length);
    const median = this.median();
    if (Number.isNaN(median)) return undefined;
    return this.judge(median, nowMs);
  }

  private judge(median: number, nowMs: number): GovernorDecision | undefined {
    const { targetFrameMs, lowerAbove, raiseBelow, reactionMs, minChangeIntervalMs } = this.options;
    const over = median > targetFrameMs * lowerAbove;
    const under = median < targetFrameMs * raiseBelow;
    this.overSinceMs = over ? (this.overSinceMs ?? nowMs) : undefined;
    this.underSinceMs = under ? (this.underSinceMs ?? nowMs) : undefined;
    if (nowMs - this.lastChangeAtMs < minChangeIntervalMs) return undefined;
    if (over && this.currentLevel < this.levels - 1 && nowMs - (this.overSinceMs ?? nowMs) >= reactionMs) {
      if (this.raisedFrom === this.currentLevel + 1) this.raiseBackoff = Math.min(this.raiseBackoff * 2, 8);
      this.raisedFrom = undefined;
      return this.change(this.currentLevel + 1, 'lower', median, nowMs);
    }
    if (under && this.currentLevel > 0 && nowMs - (this.underSinceMs ?? nowMs) >= this.raiseWaitMs) {
      this.lastRaiseAtMs = nowMs;
      this.raisedFrom = this.currentLevel;
      return this.change(this.currentLevel - 1, 'raise', median, nowMs);
    }
    // A raise that held for 8 stable intervals ends the backoff.
    if (this.raisedFrom !== undefined && nowMs - this.lastRaiseAtMs > this.options.stableMs * 8) this.raiseBackoff = 1;
    return undefined;
  }

  private change(level: number, direction: 'lower' | 'raise', medianMs: number, nowMs: number): GovernorDecision {
    this.currentLevel = level;
    this.lastChangeAtMs = nowMs;
    // The new level changes the cost of every frame: judge it on fresh samples.
    const lastFrameAtMs = this.lastFrameAtMs;
    this.restart();
    this.lastFrameAtMs = lastFrameAtMs;
    return { level, direction, medianMs };
  }
}
