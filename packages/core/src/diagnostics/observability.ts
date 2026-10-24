// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The engine's observability (M3 plan, increment 8): phase timing with User Timing measures (F118, F119), leveled
 * logging with a pluggable sink (F120) and event traces (F121). Everything is off or quiet by default and then costs
 * a branch; nothing touches a browser API at import time.
 */

/** Log levels, quietest last. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

/** One log message. */
export interface LogEntry {
  readonly level: Exclude<LogLevel, 'silent'>;
  readonly message: string;
  /** Engine time of the message, in milliseconds. */
  readonly timeMs: number;
}

/** Receives the engine's log messages in place of the console. */
export type LogSink = (entry: LogEntry) => void;

/** The frame phases timed when phase timing is on (`GlobeDiagnostics.setPhaseTiming`), in frame order. */
export const FRAME_PHASES = ['update', 'selection', 'scheduling', 'upload', 'render'] as const;
/** A frame phase. */
export type FramePhase = (typeof FRAME_PHASES)[number];

/** Index of the update phase. */
export const PHASE_UPDATE = 0;
/** Index of the selection phase. */
export const PHASE_SELECTION = 1;
/** Index of the scheduling phase. */
export const PHASE_SCHEDULING = 2;
/** Index of the upload phase. */
export const PHASE_UPLOAD = 3;
/** Index of the render phase. */
export const PHASE_RENDER = 4;

/** Durations of the last timed frame's phases, in milliseconds. */
export type PhaseTimesMs = Readonly<Record<FramePhase, number>>;

/** One event of a trace (F121): plain data, ready for `JSON.stringify`. */
export interface TraceEvent {
  readonly timeMs: number;
  readonly kind: 'tile' | 'request' | 'camera';
  /** For tiles a state (`queued`, `ready`, `failed`, `evicted`), for requests `start`, `end`, `cancel` or `fail`. */
  readonly event: string;
  /** The tile (`level/x/y`) or the camera's eye (`x,y,z` ECEF meters). */
  readonly subject: string;
}

/** The diagnostics API of an engine instance (`Globe.diagnostics`). */
export interface GlobeDiagnostics {
  /** Changes the log level at runtime. */
  setLogLevel(level: LogLevel): void;
  /**
   * Times each frame's phases (off by default); with `userTiming` (the default) each phase is also a
   * `vibeglobe:<phase>` User Timing measure, visible in the browser's performance panel.
   */
  setPhaseTiming(enabled: boolean, userTiming?: boolean): void;
  /** The phases of the last frame timed while phase timing was on. */
  phaseTimesMs(): PhaseTimesMs;
  /** Starts recording an event trace, dropping any recorded one. */
  startTrace(): void;
  /** Stops recording and returns the events, oldest first (empty when no trace was recording). */
  stopTrace(): TraceEvent[];
}

/** The console where there is one (core has no DOM types). */
function consoleOf(): Record<'debug' | 'info' | 'warn' | 'error', (text: string) => void> | undefined {
  return (globalThis as { console?: Record<'debug' | 'info' | 'warn' | 'error', (text: string) => void> }).console;
}

const LEVELS: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };
const TRACE_CAPACITY = 20_000;

interface UserTiming {
  mark(name: string): unknown;
  measure(name: string, start: string, end: string): unknown;
}

/** The leveled logger of an engine instance. */
class Logger {
  private threshold: number;

  constructor(
    level: LogLevel,
    private readonly sink: LogSink | undefined,
    private readonly now: () => number,
  ) {
    this.threshold = LEVELS[level];
  }

  /** Changes the level. */
  setLevel(level: LogLevel): void {
    this.threshold = LEVELS[level];
  }

  /** True when messages at `level` are emitted: callers build costly messages only then. */
  enabled(level: Exclude<LogLevel, 'silent'>): boolean {
    return LEVELS[level] >= this.threshold;
  }

  /** Emits a message at `level` when the level allows it, to the sink or the console. */
  log(level: Exclude<LogLevel, 'silent'>, message: string): void {
    if (!this.enabled(level)) return;
    if (this.sink) this.sink({ level, message, timeMs: this.now() });
    else consoleOf()?.[level](`[vibeglobe] ${message}`);
  }
}

/** Times the phases of each frame (F118, F119). */
export class PhaseTimer {
  enabled = false;
  /** Also emit User Timing marks and measures. */
  userTiming = true;
  private readonly ends = new Float64Array(FRAME_PHASES.length + 1);
  private readonly durations = new Float64Array(FRAME_PHASES.length);
  private readonly timing: UserTiming | undefined;
  private phase = 0;

  constructor(private readonly now: () => number) {
    const candidate = (globalThis as { performance?: Partial<UserTiming> }).performance;
    this.timing =
      typeof candidate?.mark === 'function' && typeof candidate.measure === 'function'
        ? (candidate as UserTiming)
        : undefined;
  }

  /** Starts a frame's timing. */
  begin(): void {
    if (!this.enabled) return;
    this.ends[0] = this.now();
    this.phase = 0;
    if (this.userTiming) this.timing?.mark('vibeglobe:frame');
  }

  /** Ends phase `index`: the time since the previous phase ended is its duration. */
  end(index: number): void {
    if (!this.enabled) return;
    const nowMs = this.now();
    this.durations[index] = nowMs - (this.ends[this.phase] ?? nowMs);
    this.ends[index + 1] = nowMs;
    if (this.userTiming && this.timing) this.measure(index);
    this.phase = index + 1;
  }

  /** Marks the end of phase `index` and measures it; the entries are cleared at once (traces keep them). */
  private measure(index: number): void {
    const timing = this.timing as UserTiming & { clearMarks?(): void; clearMeasures?(): void };
    const name = FRAME_PHASES[index] ?? 'render';
    timing.mark(`vibeglobe:${name}:end`);
    timing.measure(
      `vibeglobe:${name}`,
      this.phase === 0 ? 'vibeglobe:frame' : this.startMark(),
      `vibeglobe:${name}:end`,
    );
    if (index === FRAME_PHASES.length - 1) {
      timing.clearMarks?.();
      timing.clearMeasures?.();
    }
  }

  /** The last timed frame's phase durations. */
  times(): PhaseTimesMs {
    const out: Record<string, number> = {};
    FRAME_PHASES.forEach((phase, i) => (out[phase] = this.durations[i] ?? 0));
    return out as PhaseTimesMs;
  }

  private startMark(): string {
    return `vibeglobe:${FRAME_PHASES[this.phase - 1] ?? 'update'}:end`;
  }
}

/** Records trace events while a trace runs (F121); a ring buffer keeps the newest. */
class Tracer {
  enabled = false;
  private events: TraceEvent[] = [];
  private next = 0;

  constructor(private readonly now: () => number) {}

  /** Starts recording, dropping any earlier events. */
  start(): void {
    this.events = [];
    this.next = 0;
    this.enabled = true;
  }

  /** Stops recording and returns the events, oldest first. */
  stop(): TraceEvent[] {
    this.enabled = false;
    const events =
      this.events.length < TRACE_CAPACITY
        ? this.events
        : [...this.events.slice(this.next), ...this.events.slice(0, this.next)];
    this.events = [];
    return events;
  }

  /** Records an event; callers check {@link Tracer.enabled} first, so a stopped trace builds nothing. */
  record(kind: TraceEvent['kind'], event: string, subject: string): void {
    const entry: TraceEvent = { timeMs: this.now(), kind, event, subject };
    if (this.events.length < TRACE_CAPACITY) this.events.push(entry);
    else this.events[this.next] = entry;
    this.next = (this.next + 1) % TRACE_CAPACITY;
  }
}

/** The observability of one engine instance, shared by its parts. */
export interface Observability {
  readonly logger: Logger;
  readonly timer: PhaseTimer;
  readonly tracer: Tracer;
}

/** Creates an instance's observability and its public API. */
export function createObservability(
  level: LogLevel,
  sink: LogSink | undefined,
  now: () => number,
): Observability & { readonly api: GlobeDiagnostics } {
  const logger = new Logger(level, sink, now);
  const timer = new PhaseTimer(now);
  const tracer = new Tracer(now);
  return {
    logger,
    timer,
    tracer,
    api: {
      setLogLevel: (next) => logger.setLevel(next),
      setPhaseTiming: (enabled, userTiming = true) => {
        timer.enabled = enabled;
        timer.userTiming = userTiming;
      },
      phaseTimesMs: () => timer.times(),
      startTrace: () => tracer.start(),
      stopTrace: () => tracer.stop(),
    },
  };
}
