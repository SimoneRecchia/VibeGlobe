import type { GpuProbeResult } from '@vibeglobe/renderer';

declare global {
  interface Window {
    /** The GPU probes' result on `?experiment=gpu-probes`, or the error that stopped them. */
    vibeglobeGpuProbes?: GpuProbeResult | { readonly error: string };
  }
}

/**
 * Runs the GPU readback probes of ADR 0004 and 0005 (`?experiment=gpu-probes&backend=webgpu|webgl2[&depth=fragment]`)
 * and exposes the result to tests; the page shows no globe.
 */
export async function runGpuProbesPage(params: URLSearchParams, status: HTMLElement | null): Promise<void> {
  const { runGpuProbes } = await import('@vibeglobe/renderer');
  try {
    const result = await runGpuProbes({
      backend: params.get('backend') === 'webgl2' ? 'webgl2' : 'webgpu',
      depth: params.get('depth') === 'fragment' ? 'fragment' : 'auto',
    });
    window.vibeglobeGpuProbes = result;
    if (status) status.textContent = JSON.stringify(result);
  } catch (error) {
    window.vibeglobeGpuProbes = { error: error instanceof Error ? error.message : String(error) };
  }
}
