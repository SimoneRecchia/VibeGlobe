import { FrameStats, type GeoPosition, type Globe } from '@vibeglobe/core';

/** Called once per frame with the frame statistics after the frame was recorded. */
export type FrameListener = (stats: FrameStats, timestampMs: number) => void;

/** A running frame loop. */
export interface FrameLoop {
  /** Main-thread CPU time of the most recent frames' work, oldest first (at most `CPU_SAMPLE_CAPACITY`). */
  cpuFrameTimesMs(): number[];
  /** Forgets the CPU samples, so a measurement window starts empty. */
  resetCpuSamples(): void;
  /** GPU time of the most recent frames where the renderer measures it (`?gpuTiming=1`), oldest first. */
  gpuFrameTimesMs?(): number[];
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

/**
 * Drives continuous circular drag motion through the navigation API and records the engine's CPU time per frame: a
 * marker callback registered before each drag step runs first in the next animation frame, and the engine's `frame`
 * event ends the measurement, so the sample covers the engine's whole frame (benchmark scenarios `drag-*`).
 */
export function startDragLoop(globe: Globe): FrameLoop {
  const cpuMs = new Float64Array(CPU_SAMPLE_CAPACITY);
  const gpuMs = new Float64Array(CPU_SAMPLE_CAPACITY);
  let cpuCount = 0;
  let gpuCount = 0;
  let frameStartMs = -1;
  let handle = 0;
  let angle = 0;
  const center = { xPx: 0, yPx: 0 };
  const point = { xPx: 0, yPx: 0 };
  let anchor: GeoPosition | undefined;
  const gpuTiming = new URLSearchParams(location.search).has('gpuTiming');
  const markStart = (): void => {
    frameStartMs = performance.now();
  };
  const unsubscribe = globe.on('frame', () => {
    if (frameStartMs < 0) return;
    cpuMs[cpuCount % CPU_SAMPLE_CAPACITY] = performance.now() - frameStartMs;
    cpuCount++;
    frameStartMs = -1;
    // The latest GPU time the renderer resolved (timestamp queries arrive a few frames late).
    const gpu = gpuTiming ? globe.rendererStats().gpuFrameMs : null;
    if (gpu !== null) gpuMs[gpuCount++ % CPU_SAMPLE_CAPACITY] = gpu;
  });
  const tick = (): void => {
    anchor ??= globe.navigation.grab(center);
    if (anchor) {
      angle += 0.05;
      point.xPx = center.xPx + 30 * Math.cos(angle);
      point.yPx = center.yPx + 30 * Math.sin(angle);
      requestAnimationFrame(markStart);
      globe.navigation.dragTo(anchor, point);
    }
    handle = requestAnimationFrame(tick);
  };
  void globe.ready.then(() => {
    const canvas = document.querySelector('#globe');
    center.xPx = (canvas?.clientWidth ?? 0) / 2;
    center.yPx = (canvas?.clientHeight ?? 0) / 2;
    handle = requestAnimationFrame(tick);
  });
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
      gpuCount = 0;
    },
    gpuFrameTimesMs: () => ringSamples(gpuMs, gpuCount),
    stop() {
      cancelAnimationFrame(handle);
      unsubscribe();
    },
  };
}

/** The samples of a ring buffer that has received `count` values, oldest first. */
function ringSamples(ring: Float64Array, count: number): number[] {
  const kept = Math.min(count, ring.length);
  return Array.from({ length: kept }, (_, index) => ring[(count - kept + index) % ring.length] as number);
}
