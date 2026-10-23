import type { Emitter } from './emitter.js';
import { GlobeError as GlobeErrorClass, type GlobeError } from './errors.js';
import type { FrameCapture, GlobeEvents, RendererBackend } from './types.js';

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

/** What {@link captureWhenDrawn} needs from its globe. */
export interface CaptureSource {
  readonly ready: Promise<void>;
  readonly waits: FrameWaits;
  /** The renderer (undefined once destroyed), the failure that stopped the globe if any, and the frames drawn. */
  state(): { renderer: RendererBackend | undefined; failure: GlobeError | undefined; frames: number };
  /** Draws a frame now, in this task. */
  draw(renderer: RendererBackend): void;
}

/**
 * Captures the next drawn frame (ADR 0012, Capture): drawn and read in one task, since the canvas keeps the frame
 * only until the browser presents it; when nothing could be drawn (a recovery, a container without a size), waits for
 * a drawn frame and tries again (KB-051).
 */
export async function captureWhenDrawn(source: CaptureSource): Promise<FrameCapture> {
  await source.ready;
  for (;;) {
    const { renderer, failure, frames } = source.state();
    if (!renderer) throw new GlobeErrorClass('destroyed', 'The globe was destroyed');
    if (failure) throw failure;
    source.draw(renderer);
    if (source.state().frames > frames) return renderer.capture();
    await source.waits.next();
  }
}

/**
 * `Globe.ready`: `bind` receives the promise's resolve and reject, `start` runs, and a start that throws or rejects
 * goes to `fail` as a GlobeError ('renderer-failed' for any other error). Callers that never await the promise see no
 * unhandled rejection: the error event reports it.
 */
export function startedPromise(
  bind: (resolve: () => void, reject: (error: GlobeError) => void) => void,
  start: () => Promise<void>,
  fail: (error: GlobeError) => void,
): Promise<void> {
  const ready = new Promise<void>((resolve, reject) => {
    bind(resolve, reject);
    start().catch((error: unknown) =>
      fail(
        error instanceof GlobeErrorClass
          ? error
          : new GlobeErrorClass('renderer-failed', 'The renderer failed to start', { cause: error }),
      ),
    );
  });
  ready.catch(() => undefined);
  return ready;
}
