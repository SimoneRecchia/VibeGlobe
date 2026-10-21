import type { GpuProbeOptions, GpuProbeResult } from './gpu-probes.js';

/**
 * Runs the GPU readback probes of ADR 0004 (eye-relative precision, reassociation canary) and ADR 0005 (depth
 * reconstruction) on a renderer set up like the engine's. A diagnostic for tests and the hardware matrix
 * (`docs/guides/hardware-testing.md`), not part of drawing a globe; three.js loads only when it is called.
 */
export async function runGpuProbes(options: GpuProbeOptions): Promise<GpuProbeResult> {
  const { runGpuProbesNow } = await import('./gpu-probes.js');
  return runGpuProbesNow(options);
}
