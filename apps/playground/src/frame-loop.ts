import { FrameStats } from '@vibeglobe/core';

/** Called once per frame with the frame statistics after the frame was recorded. */
export type FrameListener = (stats: FrameStats, timestampMs: number) => void;

/** A running frame loop. */
export interface FrameLoop {
  /** Main-thread CPU time of the most recent frames' work, oldest first (at most `CPU_SAMPLE_CAPACITY`). */
  cpuFrameTimesMs(): number[];
  /** Forgets the CPU samples, so a measurement window starts empty. */
  resetCpuSamples(): void;
  stop(): void;
}

const CPU_SAMPLE_CAPACITY = 1200;

/**
 * Runs a `requestAnimationFrame` loop that records frame statistics and each frame's CPU time in a preallocated ring
 * buffer (no per-frame allocation, no growing performance-entry buffer: KB-006). Until the engine has its own loop
 * (milestone 2), this is what the debug overlay and the benchmarks observe.
 */
export function startFrameLoop(onFrame: FrameListener): FrameLoop {
  const stats = new FrameStats();
  const cpuMs = new Float64Array(CPU_SAMPLE_CAPACITY);
  let cpuCount = 0;
  let handle = 0;
  const tick = (timestampMs: number): void => {
    const startMs = performance.now();
    stats.recordFrame(timestampMs);
    onFrame(stats, timestampMs);
    cpuMs[cpuCount % CPU_SAMPLE_CAPACITY] = performance.now() - startMs;
    cpuCount++;
    handle = requestAnimationFrame(tick);
  };
  handle = requestAnimationFrame(tick);
  return {
    cpuFrameTimesMs() {
      const count = Math.min(cpuCount, CPU_SAMPLE_CAPACITY);
      return Array.from(
        { length: count },
        (_, index) => cpuMs[(cpuCount - count + index) % CPU_SAMPLE_CAPACITY] as number,
      );
    },
    resetCpuSamples() {
      cpuCount = 0;
    },
    stop() {
      cancelAnimationFrame(handle);
    },
  };
}
