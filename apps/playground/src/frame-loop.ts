import { FrameStats } from '@vibeglobe/core';

/** Called once per frame with the frame statistics after the frame was recorded. */
export type FrameListener = (stats: FrameStats, timestampMs: number) => void;

/**
 * Runs a `requestAnimationFrame` loop that records frame statistics and a `vge:frame` performance measure per frame.
 * Until the engine has its own loop (milestone 2), this is what the debug overlay and the benchmarks observe.
 */
export function startFrameLoop(onFrame: FrameListener): () => void {
  const stats = new FrameStats();
  let handle = 0;
  const tick = (timestampMs: number): void => {
    const startMs = performance.now();
    stats.recordFrame(timestampMs);
    onFrame(stats, timestampMs);
    performance.measure('vge:frame', { start: startMs, end: performance.now() });
    handle = requestAnimationFrame(tick);
  };
  handle = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(handle);
}
