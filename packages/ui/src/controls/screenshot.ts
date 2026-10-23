/**
 * The screenshot control (F416): a PNG of the current view, taken once the view has loaded (the engine's `idle`), from
 * the engine's own frame (`Globe.captureFrame`), with the credits of the visible sources (`Globe.credits()`: text and
 * logos, required ones first) drawn into its bottom-right corner. Sizes other than the canvas's are scaled from the
 * canvas frame until the engine can render a view at another size (track A's hook request 4).
 */
import type { Credit, Globe } from '@vibeglobe/core';
import type { ControlContext, ControlPosition, UiControl } from '../ui.js';
import { controlFrame, icon, iconButton, ICONS, label } from './dom.js';

/** Options of {@link ScreenshotControl}. */
export interface ScreenshotControlOptions {
  readonly id?: string;
  readonly position?: ControlPosition;
  /** The downloaded file's name (default `vibeglobe.png`). */
  readonly fileName?: string;
}

/** The size of an exported image: a scale of the canvas, or a size in pixels. */
export type ScreenshotSize = { readonly scale: number } | { readonly widthPx: number; readonly heightPx: number };

/** Waits for the engine to go idle (every tile of the view drawn), or for the next idle if it is drawing. */
function viewLoaded(globe: Globe): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      stop();
      resolve();
    };
    const stop = globe.on('idle', done);
    // An engine already idle draws no frame: ask for one, whose end is the idle.
    globe.requestRender();
  });
}

/** Loads an image (a credit logo). */
function loadImage(src: string): Promise<HTMLImageElement | undefined> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(undefined);
    image.src = src;
  });
}

/** Draws the credits as a strip in the bottom-right corner of a 2D context, sized for the image's scale. */
async function drawCredits(
  context: CanvasRenderingContext2D,
  credits: readonly Credit[],
  widthPx: number,
  heightPx: number,
  scale: number,
): Promise<void> {
  if (credits.length === 0) return;
  const fontPx = Math.max(11, Math.round(11 * scale));
  const pad = Math.round(fontPx / 2);
  const gap = fontPx;
  const logoHeight = Math.round(fontPx * 1.3);
  context.font = `${fontPx}px system-ui, sans-serif`;
  const items = await Promise.all(
    credits.map(async (credit) => {
      const logo = credit.logo ? await loadImage(credit.logo.src) : undefined;
      const logoWidth = logo ? (logo.naturalWidth / Math.max(1, logo.naturalHeight)) * logoHeight : 0;
      return { credit, logo, logoWidth, textWidth: context.measureText(credit.text).width };
    }),
  );
  const contentWidth =
    items.reduce((sum, item) => sum + item.textWidth + (item.logo ? item.logoWidth + pad : 0), 0) +
    gap * (items.length - 1);
  const stripWidth = Math.min(widthPx, contentWidth + 2 * pad);
  const stripHeight = logoHeight + 2 * pad;
  context.fillStyle = 'rgba(255, 255, 255, 0.85)';
  context.fillRect(widthPx - stripWidth, heightPx - stripHeight, stripWidth, stripHeight);
  context.fillStyle = '#222222';
  context.textBaseline = 'middle';
  let x = widthPx - stripWidth + pad;
  const middle = heightPx - stripHeight / 2;
  for (const item of items) {
    if (item.logo) {
      context.drawImage(item.logo, x, middle - logoHeight / 2, item.logoWidth, logoHeight);
      x += item.logoWidth + pad;
    }
    context.fillText(item.credit.text, x, middle);
    x += item.textWidth + gap;
  }
}

/**
 * Renders the current view to a PNG of `size` (default: the canvas), with the visible sources' credits. Resolves once
 * the view has loaded.
 *
 * @param globe - The engine instance.
 */
export async function captureView(globe: Globe, size: ScreenshotSize = { scale: 1 }): Promise<Blob> {
  await viewLoaded(globe);
  const frame = await globe.captureFrame();
  const credits = globe.credits();
  const widthPx = 'scale' in size ? Math.round(frame.widthPx * size.scale) : size.widthPx;
  const heightPx = 'scale' in size ? Math.round(frame.heightPx * size.scale) : size.heightPx;
  const source = document.createElement('canvas');
  source.width = frame.widthPx;
  source.height = frame.heightPx;
  source.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(frame.rgba), frame.widthPx), 0, 0);
  const output = document.createElement('canvas');
  output.width = widthPx;
  output.height = heightPx;
  const context = output.getContext('2d');
  if (context === null) throw new Error('No 2D canvas context');
  // Cover the output, keeping the frame's aspect ratio: a different aspect crops the frame's sides or top and bottom.
  const cover = Math.max(widthPx / frame.widthPx, heightPx / frame.heightPx);
  const drawnWidth = frame.widthPx * cover;
  const drawnHeight = frame.heightPx * cover;
  context.drawImage(source, (widthPx - drawnWidth) / 2, (heightPx - drawnHeight) / 2, drawnWidth, drawnHeight);
  await drawCredits(context, credits, widthPx, heightPx, Math.max(1, heightPx / Math.max(1, frame.heightPx)));
  return new Promise((resolve, reject) =>
    output.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The PNG could not be encoded'))), 'image/png'),
  );
}

/** A button that downloads the view as a PNG. */
export class ScreenshotControl implements UiControl {
  readonly id: string;
  readonly position: ControlPosition;
  readonly #fileName: string;
  #context: ControlContext | undefined;
  #button: HTMLButtonElement | undefined;
  #status: HTMLElement | undefined;
  #state: 'idle' | 'saving' | 'failed' = 'idle';

  /** @param options - Placement and file name; every field is optional. */
  constructor(options: ScreenshotControlOptions = {}) {
    this.id = options.id ?? 'screenshot';
    this.position = options.position ?? 'top-right';
    this.#fileName = options.fileName ?? 'vibeglobe.png';
  }

  /** Builds the control's element (UiControl). */
  mount(context: ControlContext): HTMLElement {
    this.#context = context;
    const frame = controlFrame('screenshot');
    const button = iconButton('screenshot', icon(ICONS.camera));
    button.addEventListener('click', () => void this.download());
    const status = document.createElement('div');
    status.className = 'vg-ui__status';
    status.setAttribute('role', 'status');
    frame.append(button, status);
    this.#button = button;
    this.#status = status;
    return frame;
  }

  /** Renders the view (see {@link captureView}). */
  async capture(size?: ScreenshotSize): Promise<Blob> {
    const globe = this.#context?.globe;
    if (globe === undefined) throw new Error('The control is not mounted');
    return captureView(globe, size);
  }

  /** Renders the view at the canvas size and downloads it. */
  async download(size?: ScreenshotSize): Promise<void> {
    this.#show('saving');
    try {
      const blob = await this.capture(size);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = this.#fileName;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      this.#show('idle');
    } catch {
      this.#show('failed');
    }
  }

  /** Updates texts and accessible names to the current language (UiControl). */
  localize(): void {
    if (this.#button !== undefined && this.#context !== undefined)
      label(this.#button, this.#context.i18n.t('screenshot.label'));
    this.#show(this.#state);
  }

  /** Nothing to release (UiControl). */
  destroy(): void {
    this.#context = undefined;
  }

  #show(state: 'idle' | 'saving' | 'failed'): void {
    this.#state = state;
    const i18n = this.#context?.i18n;
    if (this.#status === undefined || i18n === undefined) return;
    this.#status.textContent =
      state === 'saving' ? i18n.t('screenshot.saving') : state === 'failed' ? i18n.t('screenshot.failed') : '';
    if (this.#button !== undefined) this.#button.disabled = state === 'saving';
  }
}
