import { GlobeError } from '@vibeglobe/core';
import type { DrawingSurface } from './three-backend.js';
import { createCanvas } from './three-hooks.js';

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/**
 * The backend's canvases: the one shown in the page and the one the current renderer draws into. They differ while a
 * replacement renderer starts after a loss or a failed self-test: the new canvas is shown only once that renderer has
 * its imagery and pipelines (ADR 0010 §8), and never if the backend is destroyed first (KB-035).
 */
export class CanvasSlot {
  /** The canvas shown in the page (or the OffscreenCanvas drawn into). */
  private shown: AnyCanvas | undefined;
  private drawing: AnyCanvas | undefined;
  /** Whether the canvas given in the options has been used; later renderers get fresh canvases. */
  private givenUsed = false;

  constructor(private readonly surface: DrawingSurface) {}

  /** The canvas shown in a page, which receives input; none for an OffscreenCanvas (its host forwards input). */
  get inputElement(): HTMLCanvasElement | undefined {
    return this.surface.kind === 'element' ? (this.shown as HTMLCanvasElement | undefined) : undefined;
  }

  /**
   * The canvas for a new renderer: the given one first; then a fresh element in a page container (an OffscreenCanvas
   * cannot be replaced, so recovery fails there).
   */
  next(): AnyCanvas {
    let canvas: AnyCanvas;
    if (!this.givenUsed) {
      this.givenUsed = true;
      canvas = this.surface.canvas ?? this.fresh();
    } else if (this.surface.kind === 'offscreen') {
      throw new GlobeError('renderer-failed', 'An OffscreenCanvas cannot be replaced after a device or context loss');
    } else {
      canvas = this.fresh();
    }
    this.drawing = canvas;
    return canvas;
  }

  /** Marks the canvas of a renderer that failed its self-test as shown, so the next one replaces it. */
  replaceFailed(canvas: AnyCanvas): void {
    this.shown ??= canvas;
  }

  /** Shows the canvas the current renderer draws into, in place of the one shown so far. */
  attach(): void {
    const canvas = this.drawing;
    if (this.surface.kind === 'element' && canvas) {
      const element = canvas as HTMLCanvasElement;
      const previous = this.shown as HTMLCanvasElement | undefined;
      if (previous?.isConnected && previous !== element) previous.replaceWith(element);
      else if (!element.isConnected) this.surface.container.appendChild(element);
    }
    this.shown = canvas;
  }

  /** Puts an element in the shown canvas's place (the static failure message). */
  replaceWith(element: HTMLElement): void {
    if (this.surface.kind !== 'element') return;
    const canvas = this.shown as HTMLCanvasElement | undefined;
    if (canvas?.isConnected) canvas.replaceWith(element);
    else this.surface.container.appendChild(element);
  }

  /** Removes the shown canvas from the page. */
  remove(): void {
    if (this.surface.kind === 'element') (this.shown as HTMLCanvasElement | undefined)?.remove();
  }

  private fresh(): HTMLCanvasElement {
    if (this.surface.kind !== 'element') throw new Error('A replacement canvas needs a page container');
    return createCanvas(this.surface.container.ownerDocument, this.shown as HTMLCanvasElement | undefined);
  }
}
