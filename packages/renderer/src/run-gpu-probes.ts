// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * `@vibeglobe/renderer/gpu-probes`: the GPU readback probes of ADR 0004 and 0005, an entry of their own so a globe's
 * bundle carries none of them.
 *
 * @packageDocumentation
 */
import type { GpuProbeOptions, GpuProbeResult } from './gpu-probes.js';

export type { GpuProbeOptions, GpuProbeResult } from './gpu-probes.js';

/**
 * Runs the GPU readback probes of ADR 0004 (eye-relative precision, reassociation canary) and ADR 0005 (depth
 * reconstruction) on a renderer set up like the engine's. A diagnostic for tests and the hardware matrix
 * (`docs/guides/hardware-testing.md`), not part of drawing a globe; three.js loads only when it is called.
 */
export async function runGpuProbes(options: GpuProbeOptions): Promise<GpuProbeResult> {
  const { runGpuProbesNow } = await import('./gpu-probes.js');
  return runGpuProbesNow(options);
}
