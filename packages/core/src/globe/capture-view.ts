import type { Camera } from '../camera/camera.js';
import { refuseExtensionReadback } from './display-only.js';
import { GlobeError } from './errors.js';
import { captureWhenDrawn, type FrameWaits } from './frame-waits.js';
import type { FrameCapture } from './renderer-stats.js';
import type { SurfaceFrame } from './surface-frame.js';
import type { Globe, RendererBackend } from './types.js';
import type { MutableFrameView } from './view-geometry.js';

/** The size of a {@link captureViewAt} image, in pixels. */
export interface CaptureSize {
  readonly widthPx: number;
  readonly heightPx: number;
}

/** What a view capture needs from the engine. */
export interface CaptureViewHost {
  /** The canvas's CSS size: the camera's viewport. */
  cssSize(): CaptureSize;
  /** The live render-target pixels per CSS pixel. */
  livePixelRatio(): number;
  /** The renderer's largest texture side: the drawing buffer cannot be larger. */
  maxTextureSize(): number;
  /** Selects tiles for this many render-target pixels per CSS pixel (the live ratio again when undefined). */
  selectFor(pixelRatio: number | undefined): void;
  /** Resolves at the next frame after which nothing is loading or fading. */
  idle(): Promise<void>;
  /** Draws one frame into a drawing buffer of this pixel ratio, reads it, and restores the live size. */
  drawAt(pixelRatio: number): Promise<FrameCapture>;
}

/** Validates a capture size given by the caller; throws a typed GlobeError. */
function validateCaptureSize(size: unknown): CaptureSize {
  const { widthPx, heightPx } = (size ?? {}) as Partial<CaptureSize>;
  for (const [name, value] of [
    ['widthPx', widthPx],
    ['heightPx', heightPx],
  ] as const)
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
      throw new GlobeError('invalid-option', `captureView: ${name} must be a positive integer, got ${String(value)}`);
  return { widthPx: widthPx as number, heightPx: heightPx as number };
}

/** The `width` × `height` center of `frame`, top row first. */
function cropCenter(frame: FrameCapture, widthPx: number, heightPx: number): FrameCapture {
  const left = Math.floor((frame.widthPx - widthPx) / 2);
  const top = Math.floor((frame.heightPx - heightPx) / 2);
  if (left === 0 && top === 0 && frame.widthPx === widthPx) return frame;
  const rgba = new Uint8ClampedArray(widthPx * heightPx * 4);
  for (let row = 0; row < heightPx; row++) {
    const start = ((top + row) * frame.widthPx + left) * 4;
    rgba.set(frame.rgba.subarray(start, start + widthPx * 4), row * widthPx * 4);
  }
  return { widthPx, heightPx, rgba };
}

/**
 * The current view as an image of `size` (F416): the view covers the image (another aspect ratio crops the view's
 * sides, or its top and bottom). The engine selects tiles for the image's resolution while the live view keeps
 * rendering (it shows the finer tiles too), waits until they have loaded, then draws one frame of the same view into a
 * drawing buffer at the image's scale and reads it: the canvas shows the same picture, only sharper, for that frame.
 */
async function captureViewAt(host: CaptureViewHost, size: CaptureSize): Promise<FrameCapture> {
  const css = host.cssSize();
  // The half pixel keeps the drawing buffer, rounded down by the browser, at least as large as the image.
  const pixelRatio = Math.max((size.widthPx + 0.5) / css.widthPx, (size.heightPx + 0.5) / css.heightPx);
  const largest = Math.max(css.widthPx, css.heightPx) * pixelRatio;
  if (largest > host.maxTextureSize())
    throw new GlobeError(
      'invalid-option',
      `captureView: ${size.widthPx} × ${size.heightPx} needs a ${Math.ceil(largest)} px drawing buffer, larger than ` +
        `this GPU's ${host.maxTextureSize()} px`,
    );
  host.selectFor(Math.max(pixelRatio, host.livePixelRatio()));
  try {
    await host.idle();
    return cropCenter(await host.drawAt(pixelRatio), size.widthPx, size.heightPx);
  } finally {
    host.selectFor(undefined);
  }
}

/** What {@link ViewCaptures} needs from its engine: the public globe and its private parts, read when used. */
export interface CaptureParts {
  readonly globe: Pick<Globe, 'ready' | 'frameNumber' | 'requestRender' | 'on'>;
  /** Throws when the globe is destroyed or a display-only source is drawn (F323, ADR 0031), naming `api`. */
  check(api: 'captureFrame' | 'captureView'): void;
  waits(): FrameWaits;
  /** The renderer, undefined once destroyed. */
  renderer(): RendererBackend | undefined;
  /** Why the renderer gave up, once it has. */
  failure(): GlobeError | undefined;
  /** Draws a frame now, in this task. */
  draw(renderer: RendererBackend): void;
  camera(): Camera;
  frameView(): MutableFrameView;
  surface(): SurfaceFrame;
}

/** `Globe.captureFrame` and `Globe.captureView`. */
export class ViewCaptures {
  constructor(private readonly parts: CaptureParts) {}

  /** The next drawn frame as the canvas holds it (ADR 0012, Capture). */
  async frame(): Promise<FrameCapture> {
    const parts = this.parts;
    parts.check('captureFrame');
    refuseExtensionReadback('captureFrame', parts.renderer());
    return captureWhenDrawn({
      ready: parts.globe.ready,
      waits: parts.waits(),
      state: () => ({ renderer: parts.renderer(), failure: parts.failure(), frames: parts.globe.frameNumber }),
      draw: (renderer) => parts.draw(renderer),
    });
  }

  /** The view as an image of `size` (see {@link captureViewAt}). */
  async view(size: CaptureSize): Promise<FrameCapture> {
    const parts = this.parts;
    parts.check('captureView');
    refuseExtensionReadback('captureView', parts.renderer());
    const checked = validateCaptureSize(size);
    await parts.globe.ready;
    return captureViewAt(this.host(), checked);
  }

  private host(): CaptureViewHost {
    const { globe, camera, frameView, surface, renderer } = this.parts;
    const live = frameView().pixelRatio;
    const resize = (pixelRatio: number): void => {
      frameView().pixelRatio = pixelRatio;
      renderer()?.resize(camera().widthPx, camera().heightPx, pixelRatio);
    };
    return {
      cssSize: () => ({ widthPx: camera().widthPx, heightPx: camera().heightPx }),
      livePixelRatio: () => live,
      maxTextureSize: () => renderer()?.capabilities.maxTextureSize ?? 0,
      selectFor: (pixelRatio) => (surface().setPixelRatio(pixelRatio ?? live), globe.requestRender()),
      idle: () =>
        new Promise((resolve) => {
          const stop = globe.on('idle', () => (stop(), resolve()));
          globe.requestRender();
        }),
      drawAt: async (pixelRatio) => {
        resize(pixelRatio);
        try {
          return await this.frame();
        } finally {
          // Back to the live size; a destroyed globe has no renderer to resize.
          if (renderer()) {
            resize(live);
            globe.requestRender();
          }
        }
      },
    };
  }
}
