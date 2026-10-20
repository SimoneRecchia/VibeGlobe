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
  /** Engine events since the page loaded, oldest first (frame events excluded; see `frameNumber`). */
  readonly events: RecordedEvent[];
  cpuFrameTimesMs(): number[];
  resetCpuSamples(): void;
}

declare global {
  interface Window {
    vibeglobePlayground?: PlaygroundTestHooks;
  }
}

const RECORDED: readonly (keyof GlobeEvents)[] = [
  'ready',
  'idle',
  'device-lost',
  'device-restored',
  'backend-fallback',
  'error',
];

/** Exposes the engine and a frame loop's samples to tests and benchmarks. */
export function exposeTestHooks(globe: Globe, loop: FrameLoop | undefined): void {
  const events: RecordedEvent[] = [];
  for (const type of RECORDED) globe.on(type, (payload) => events.push({ type, payload }));
  window.vibeglobePlayground = {
    globe,
    events,
    cpuFrameTimesMs: () => loop?.cpuFrameTimesMs() ?? [],
    resetCpuSamples: () => loop?.resetCpuSamples(),
  };
}
