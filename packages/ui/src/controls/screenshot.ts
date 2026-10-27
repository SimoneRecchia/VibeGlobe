// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The screenshot control (F416): a PNG of the current view, taken once the view has loaded (the engine's `idle`), from
 * the engine's own frame (`Globe.captureFrame`), with the credits of the visible sources (`Globe.credits()`: text and
 * logos, required ones first) drawn into its bottom-right corner. Sizes other than the canvas's are rendered by the
 * engine at that size (`Globe.captureView`), with tiles at the image's resolution.
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
    // A logo from another origin (an application CDN) must not taint the export (KB-167).
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => resolve(undefined);
    image.src = src;
  });
}

/**
 * Throws when a required credit's logo did not load (a host without CORS headers): the export would miss it, against
 * the provider's terms (KB-167).
 */
export function assertRequiredLogos(items: readonly { credit: Credit; logo: unknown }[]): void {
  const missing = items.find(({ credit, logo }) => credit.required && credit.logo && !logo);
  if (missing) throw new Error(`The required logo of "${missing.credit.text}" did not load`);
}

/**
 * The credits' rows, top row first: each credit (`widths`, logo and text) goes on the current row while it fits in
 * `maxWidth`, else starts a new one (KB-168). Returns the rows as index lists, the scale every width must shrink by
 * so that the widest credit alone fits, and the widest row's width.
 */
export function layoutCredits(
  widths: readonly number[],
  maxWidth: number,
  gap: number,
): { rows: number[][]; scale: number; widthPx: number } {
  const largest = Math.max(0, ...widths);
  const scale = largest > maxWidth ? maxWidth / largest : 1;
  const rows: number[][] = [];
  let row: number[] = [];
  let used = 0;
  let widest = 0;
  for (const [index, width] of widths.entries()) {
    const needed = (row.length === 0 ? 0 : gap * scale) + width * scale;
    if (row.length > 0 && used + needed > maxWidth) {
      rows.push(row);
      row = [];
      used = 0;
    }
    used += row.length === 0 ? width * scale : needed;
    widest = Math.max(widest, used);
    row.push(index);
  }
  if (row.length > 0) rows.push(row);
  return { rows, scale, widthPx: widest };
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
  const basePx = Math.max(11, Math.round(11 * scale));
  context.font = `${basePx}px system-ui, sans-serif`;
  const baseLogo = Math.round(basePx * 1.3);
  const loaded = await Promise.all(
    credits.map(async (credit) => {
      const logo = credit.logo ? await loadImage(credit.logo.src) : undefined;
      const logoWidth = logo ? (logo.naturalWidth / Math.max(1, logo.naturalHeight)) * baseLogo : 0;
      return { credit, logo, logoWidth, textWidth: context.measureText(credit.text).width };
    }),
  );
  assertRequiredLogos(loaded);
  const basePad = Math.round(basePx / 2);
  const widths = loaded.map((item) => item.textWidth + (item.logo ? item.logoWidth + basePad : 0));
  const layout = layoutCredits(widths, widthPx - 2 * basePad, basePx);
  // Every credit fits in the image, wrapped onto rows, the font smaller if one alone is wider (KB-168).
  const fontPx = basePx * layout.scale;
  const pad = basePad * layout.scale;
  const gap = fontPx;
  const logoHeight = baseLogo * layout.scale;
  const rowHeight = logoHeight + pad;
  context.font = `${fontPx}px system-ui, sans-serif`;
  const stripWidth = Math.min(widthPx, layout.widthPx + 2 * pad);
  const stripHeight = layout.rows.length * rowHeight + pad;
  context.fillStyle = 'rgba(255, 255, 255, 0.85)';
  context.fillRect(widthPx - stripWidth, heightPx - stripHeight, stripWidth, stripHeight);
  context.fillStyle = '#222222';
  context.textBaseline = 'middle';
  for (const [r, row] of layout.rows.entries()) {
    let x = widthPx - stripWidth + pad;
    const middle = heightPx - stripHeight + pad / 2 + rowHeight * r + rowHeight / 2;
    for (const index of row) {
      const item = loaded[index];
      if (item === undefined) continue;
      if (item.logo) {
        const logoWidth = item.logoWidth * layout.scale;
        context.drawImage(item.logo, x, middle - logoHeight / 2, logoWidth, logoHeight);
        x += logoWidth + pad;
      }
      context.fillText(item.credit.text, x, middle);
      x += item.textWidth * layout.scale + gap;
    }
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
  let frame = await globe.captureFrame();
  const canvasHeightPx = frame.heightPx;
  const widthPx = 'scale' in size ? Math.round(frame.widthPx * size.scale) : size.widthPx;
  const heightPx = 'scale' in size ? Math.round(frame.heightPx * size.scale) : size.heightPx;
  if (widthPx !== frame.widthPx || heightPx !== frame.heightPx) frame = await globe.captureView({ widthPx, heightPx });
  const credits = globe.credits();
  const output = document.createElement('canvas');
  output.width = widthPx;
  output.height = heightPx;
  const context = output.getContext('2d');
  if (context === null) throw new Error('No 2D canvas context');
  context.putImageData(new ImageData(new Uint8ClampedArray(frame.rgba), widthPx), 0, 0);
  await drawCredits(context, credits, widthPx, heightPx, Math.max(1, heightPx / Math.max(1, canvasHeightPx)));
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
