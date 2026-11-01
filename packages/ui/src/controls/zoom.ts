// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** The zoom +/- control (F419). */
import type { Globe } from '@vibeglobe/core';
import { CameraTween } from '../animation.js';
import type { ControlContext, ControlPosition, UiControl } from '../ui.js';
import { controlFrame, icon, iconButton, ICONS, label } from './dom.js';

/** Options of {@link ZoomControl}. */
export interface ZoomControlOptions {
  readonly id?: string;
  readonly position?: ControlPosition;
  /** Zoom levels per press (default 1). */
  readonly step?: number;
  /**
   * Zoom limits; the buttons are disabled at them, and at a limit the engine applies (a step that ends short of its
   * target). Defaults 0 and 22, until the engine exposes its zoom constraints (F209; docs/internal/parallel-tracks.md).
   */
  readonly minZoom?: number;
  readonly maxZoom?: number;
}

/** Zooms in and out by animated steps; presses during a step chain from its target. */
export class ZoomControl implements UiControl {
  readonly id: string;
  readonly position: ControlPosition;
  readonly #step: number;
  readonly #minZoom: number;
  readonly #maxZoom: number;
  #context: ControlContext | undefined;
  #tween: CameraTween | undefined;
  #zoomIn: HTMLButtonElement | undefined;
  #zoomOut: HTMLButtonElement | undefined;
  #stop: (() => void) | undefined;
  /** The zoom the last step asked for, compared with the applied one once the step ends. */
  #requested: number | undefined;
  /** Limits the engine applied, learned from steps that ended short; forgotten when the map's size changes. */
  #engineFloor = -Infinity;
  #engineCeiling = Infinity;

  /** @param options - Placement and behavior; every field is optional. */
  constructor(options: ZoomControlOptions = {}) {
    this.id = options.id ?? 'zoom';
    this.position = options.position ?? 'top-right';
    this.#step = options.step ?? 1;
    this.#minZoom = options.minZoom ?? 0;
    this.#maxZoom = options.maxZoom ?? 22;
  }

  /** Builds the control's element (UiControl). */
  mount(context: ControlContext): HTMLElement {
    this.#context = context;
    const frame = controlFrame('zoom');
    frame.setAttribute('role', 'group');
    this.#zoomIn = iconButton('zoom-in', icon(ICONS.plus));
    this.#zoomOut = iconButton('zoom-out', icon(ICONS.minus));
    this.#zoomIn.addEventListener('click', () => this.zoomBy(this.#step));
    this.#zoomOut.addEventListener('click', () => this.zoomBy(-this.#step));
    frame.append(this.#zoomIn, this.#zoomOut);
    this.#tween = new CameraTween(context.globe, context.container, context.reducedMotion);
    const stopCamera = context.globe.on('camera-change', () => this.#updateLimits(context.globe));
    const resize = new ResizeObserver(() => {
      this.#engineFloor = -Infinity;
      this.#engineCeiling = Infinity;
      this.#updateLimits(context.globe);
    });
    resize.observe(context.container);
    this.#stop = () => {
      stopCamera();
      resize.disconnect();
    };
    this.#updateLimits(context.globe);
    return frame;
  }

  /** Zooms by `delta` levels from the current step's target (or the camera), within the limits. */
  zoomBy(delta: number): void {
    const globe = this.#context?.globe;
    if (globe === undefined || this.#tween === undefined) return;
    const from = this.#tween.target?.zoom ?? globe.camera.zoom;
    const zoom = Math.min(this.#maxZoom, Math.max(this.#minZoom, from + delta));
    this.#requested = zoom;
    this.#tween.to({ zoom });
  }

  /** Updates texts and accessible names to the current language (UiControl). */
  localize(): void {
    const i18n = this.#context?.i18n;
    if (i18n === undefined || this.#zoomIn === undefined || this.#zoomOut === undefined) return;
    label(this.#zoomIn, i18n.t('zoom.in'));
    label(this.#zoomOut, i18n.t('zoom.out'));
  }

  /** Releases listeners and timers (UiControl). */
  destroy(): void {
    this.#stop?.();
    this.#tween?.destroy();
    this.#context = undefined;
  }

  #updateLimits(globe: Globe): void {
    const { zoom } = globe.camera;
    if (!Number.isFinite(zoom) || this.#zoomIn === undefined || this.#zoomOut === undefined) return;
    const epsilon = 1e-6;
    const requested = this.#requested;
    if (requested !== undefined && this.#tween?.target === undefined) {
      this.#requested = undefined;
      if (zoom > requested + epsilon) this.#engineFloor = zoom;
      if (zoom < requested - epsilon) this.#engineCeiling = zoom;
    }
    // Outside a learned limit again (the engine's view changed): forget it.
    if (zoom < this.#engineFloor - epsilon) this.#engineFloor = -Infinity;
    if (zoom > this.#engineCeiling + epsilon) this.#engineCeiling = Infinity;
    this.#zoomIn.disabled = zoom >= Math.min(this.#maxZoom, this.#engineCeiling) - epsilon;
    this.#zoomOut.disabled = zoom <= Math.max(this.#minZoom, this.#engineFloor) + epsilon;
  }
}
