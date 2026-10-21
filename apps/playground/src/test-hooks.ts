import type { Globe, GlobeEvents } from '@vibeglobe/core';
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
  /** Milliseconds from navigation start to the first complete frame, once drawn (F546). */
  firstFrameMs: number | undefined;
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
  'error',
];

/** Exposes the engine and a frame loop's samples to tests and benchmarks. */
export function exposeTestHooks(
  globes: readonly Globe[],
  loop: FrameLoop | undefined,
  firstFrame: Promise<number | undefined>,
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
    firstFrameMs: undefined,
  };
  void firstFrame.then((timeMs) => (hooks.firstFrameMs = timeMs));
  window.vibeglobePlayground = hooks;
}
