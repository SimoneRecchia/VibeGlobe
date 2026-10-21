import type { Emitter } from './emitter.js';
import type { GlobeError } from './errors.js';
import type { GlobeEvents } from './types.js';

/** Callers waiting for the next drawn frame, such as a capture while nothing can be drawn (KB-051). */
export class FrameWaits {
  private readonly waits = new Set<(error?: GlobeError) => void>();

  constructor(private readonly emitter: Emitter<GlobeEvents>) {}

  /** Resolves after the next drawn frame; rejects with the error given to {@link FrameWaits.end}. */
  next(): Promise<void> {
    return new Promise((resolve, reject) => {
      let off = (): void => undefined;
      const settle = (error?: GlobeError): void => {
        off();
        this.waits.delete(settle);
        if (error) reject(error);
        else resolve();
      };
      off = this.emitter.on('frame', () => settle());
      this.waits.add(settle);
    });
  }

  /** Rejects every wait: no frame will come. */
  end(error: GlobeError): void {
    for (const settle of [...this.waits]) settle(error);
  }
}
