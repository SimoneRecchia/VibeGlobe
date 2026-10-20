import type { FrameLoop } from './frame-loop.js';

/** What automated tests and benchmarks read from the playground page (`window.vibeglobePlayground`). */
interface PlaygroundTestHooks {
  cpuFrameTimesMs(): number[];
  resetCpuSamples(): void;
}

declare global {
  interface Window {
    vibeglobePlayground?: PlaygroundTestHooks;
  }
}

/** Exposes a frame loop's samples to tests and benchmarks. */
export function exposeTestHooks(loop: FrameLoop): void {
  window.vibeglobePlayground = {
    cpuFrameTimesMs: () => loop.cpuFrameTimesMs(),
    resetCpuSamples: () => loop.resetCpuSamples(),
  };
}
