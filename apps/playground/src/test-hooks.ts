import { type Globe, type GlobeEvents, type LogEntry, type WorkerEndpoint, type WorkerMessage } from '@vibeglobe/core';
import { createWorkers } from '@vibeglobe/worker';
import { geodesicInverse } from '@vibeglobe/core/geodesy';
import type { ScenarioReport } from './scenario-harness.js';
import type { FrameLoop } from './frame-loop.js';

/** An engine event as tests read it back. */
interface RecordedEvent {
  readonly type: keyof GlobeEvents;
  readonly payload: unknown;
}

/** What automated tests and benchmarks read from the playground page (`window.vibeglobePlayground`). */
interface PlaygroundTestHooks {
  /** The engine instance, through its public API only. */
  readonly globe: Globe;
  /** Every engine instance on the page (two in the two-globes scenario). */
  readonly globes: readonly Globe[];
  /**
   * Engine events since the page loaded, oldest first. Frame and idle events are excluded: they come every frame in
   * continuous motion, and recording them would grow this log without bound (see `frameNumber`).
   */
  readonly events: RecordedEvent[];
  cpuFrameTimesMs(): number[];
  resetCpuSamples(): void;
  /** GPU frame times where measured (`?gpuTiming=1` and timestamp queries), else empty. */
  gpuFrameTimesMs(): number[];
  /** Milliseconds from navigation start to the first complete frame, once drawn (F546). */
  firstFrameMs: number | undefined;
  /**
   * Mounts another engine instance in a new element, drawing into `canvas` when given (else a new one) with `backend`
   * when given (else the page's); `unmount` destroys it and removes the element.
   */
  mount(
    canvas?: HTMLCanvasElement,
    backend?: 'auto' | 'webgpu' | 'webgl2',
  ): { globe: Globe; canvas: HTMLCanvasElement; unmount(): void };
  /**
   * Runs one task of the worker program on a worker of its own, started on the first call (decoder fuzzing, F114).
   * Resolves with the task's error code, or 'ok' (an output bitmap is closed at once).
   */
  workerTask(task: string, input: unknown, transfer: Transferable[]): Promise<string>;
  /**
   * Plays a frame-stepped scenario (`zoom-orbit-to-street`, `pole-orbit`, `antimeridian-pan`) on the first globe,
   * drawing and checking every frame in the page (`src/scenario-harness.ts`); `settleTiles` lets the imagery each view
   * asks for load before the next view (KB-230).
   */
  recordScenario(name: string, darkBelow?: number, settleTiles?: boolean): Promise<ScenarioReport>;
  /** Draws a frame now and counts its holes and, with `darkBelow`, its dark pixels inside the globe (F106). */
  checkFrame(darkBelow?: number): Promise<ScenarioReport>;
  /** Shows or hides the performance HUD (F119). */
  showHud(on: boolean): void;
  /** The levels of the engine messages collected with `?logSink=1`, oldest first (F120). */
  loggedLevels(): string[];
  /** The log entries collected with `?logSink=1` (F120, F574). */
  loggedEntries(): LogEntry[];
  /** Forgets the collected log messages. */
  clearLog(): void;
  /** The geodesic distance between two positions through core's geodesic API (F158). */
  geodesicDistanceMeters(
    from: { longitudeDeg: number; latitudeDeg: number },
    to: { longitudeDeg: number; latitudeDeg: number },
  ): number;
}

/** Playground parts the hooks reach. */
interface PlaygroundParts {
  readonly showHud: (on: boolean) => void;
  readonly logEntries: LogEntry[];
}

declare global {
  interface Window {
    vibeglobePlayground?: PlaygroundTestHooks;
  }
}

const RECORDED: readonly (keyof GlobeEvents)[] = [
  'ready',
  'device-lost',
  'device-restored',
  'backend-fallback',
  'tile-error',
  'error',
];

/** A worker of the worker program outside the engine's pool, so tests can feed its tasks any input. */
function taskRunner(): PlaygroundTestHooks['workerTask'] {
  let endpoint: WorkerEndpoint | undefined;
  let next = 0;
  const pending = new Map<number, (outcome: string) => void>();
  const receive = (data: unknown): void => {
    const message = data as WorkerMessage;
    if (message.kind !== 'reply') return;
    if (message.ok) (message.output as { image?: { close?: () => void } } | undefined)?.image?.close?.();
    pending.get(message.id)?.(message.ok ? 'ok' : message.error.code);
    pending.delete(message.id);
  };
  return (task, input, transfer) => {
    endpoint ??= createWorkers().create(receive, (reason) => {
      for (const resolve of pending.values()) resolve(`worker-error: ${reason}`);
      pending.clear();
    });
    const id = ++next;
    const reply = new Promise<string>((resolve) => pending.set(id, resolve));
    endpoint.post({ kind: 'run', id, task, input }, transfer);
    return reply;
  };
}

/** The globe element's size in CSS pixels. */
function globeSize(): { widthPx: number; heightPx: number } {
  const element = document.querySelector('#globe') ?? document.body;
  return { widthPx: element.clientWidth, heightPx: element.clientHeight };
}

/** Exposes the engine and a frame loop's samples to tests and benchmarks. */
export function exposeTestHooks(
  globes: readonly Globe[],
  loop: FrameLoop | undefined,
  firstFrame: Promise<number | undefined>,
  mount: PlaygroundTestHooks['mount'],
  parts: PlaygroundParts,
): void {
  const globe = globes[0];
  if (!globe) return;
  const events: RecordedEvent[] = [];
  for (const type of RECORDED) globe.on(type, (payload) => events.push({ type, payload }));
  const hooks: PlaygroundTestHooks = {
    globe,
    globes,
    events,
    cpuFrameTimesMs: () => loop?.cpuFrameTimesMs() ?? [],
    resetCpuSamples: () => loop?.resetCpuSamples(),
    gpuFrameTimesMs: () => loop?.gpuFrameTimesMs?.() ?? [],
    firstFrameMs: undefined,
    mount,
    workerTask: taskRunner(),
    showHud: parts.showHud,
    loggedLevels: () => parts.logEntries.map((entry) => entry.level),
    loggedEntries: () => parts.logEntries.map((entry) => ({ ...entry })),
    clearLog: () => void (parts.logEntries.length = 0),
    geodesicDistanceMeters: (from, to) =>
      geodesicInverse(from.longitudeDeg, from.latitudeDeg, to.longitudeDeg, to.latitudeDeg).distanceMeters,
    async recordScenario(name, darkBelow, settleTiles) {
      const { recordScenario } = await import('./scenario-harness.js');
      return recordScenario(globe, globeSize(), name, darkBelow, settleTiles);
    },
    async checkFrame(darkBelow) {
      const { checkFrame, emptyReport } = await import('./scenario-harness.js');
      const report = emptyReport();
      checkFrame(globe, await globe.captureFrame(), globeSize(), report, 0, darkBelow);
      return report;
    },
  };
  void firstFrame.then((timeMs) => (hooks.firstFrameMs = timeMs));
  window.vibeglobePlayground = hooks;
}
