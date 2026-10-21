import type { WebGPURenderer } from 'three/webgpu';
import { releaseAllVertexArrays } from './webgl-compat.js';

const MAX_RECOVERIES = 3;
const RECOVERY_WINDOW_MS = 60_000;
const RECOVERY_BACKOFF_MS = 250;

/**
 * The recovery limit of ADR 0010 §8 and ADR 0013 #4: at most 3 recoveries within 60 s, each after a longer pause
 * (250 ms, then 500 ms, then 1 s).
 */
export class RecoveryLimiter {
  /** When the recent losses happened (host milliseconds). */
  private readonly lossTimesMs: number[] = [];

  /** Records a loss; returns the pause before the next recovery, or undefined when recovery should give up. */
  next(nowMs: number): number | undefined {
    while (this.lossTimesMs.length > 0 && nowMs - (this.lossTimesMs[0] ?? 0) > RECOVERY_WINDOW_MS) {
      this.lossTimesMs.shift();
    }
    this.lossTimesMs.push(nowMs);
    const losses = this.lossTimesMs.length;
    return losses > MAX_RECOVERIES ? undefined : RECOVERY_BACKOFF_MS * 2 ** (losses - 1);
  }

  /** Losses within the window. */
  get recentLosses(): number {
    return this.lossTimesMs.length;
  }
}

/** The static message that replaces the canvas once recovery gave up (ADR 0010 §8). */
export function createFailureMessage(document: Document): HTMLElement {
  const message = document.createElement('div');
  message.className = 'vibeglobe-renderer-failed';
  message.setAttribute('role', 'alert');
  message.textContent = 'The map cannot be shown: the graphics device stopped working. Reload the page to retry.';
  return message;
}

/** Destroys a renderer's WebGPU device or loses its WebGL2 context, at once instead of at garbage collection. */
export function releaseDevice(backend: unknown): void {
  const internals = backend as { device?: GPUDevice; gl?: WebGL2RenderingContext };
  if (internals.device) internals.device.destroy();
  else internals.gl?.getExtension('WEBGL_lose_context')?.loseContext();
}

/** Disposes a renderer and releases its device or context at once, with every cached vertex array (KB-030). */
export function releaseRenderer(renderer: WebGPURenderer): void {
  releaseAllVertexArrays(renderer.backend);
  renderer.dispose();
  releaseDevice(renderer.backend);
}
