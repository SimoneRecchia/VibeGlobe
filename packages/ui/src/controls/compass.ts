// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** The compass control (F420): shows the heading, turns to north on press, rotates the map on drag. */
import { CameraTween } from '../animation.js';
import type { ControlContext, ControlPosition, UiControl } from '../ui.js';
import { controlFrame, icon, iconButton, ICONS, label } from './dom.js';

/** Options of {@link CompassControl}. */
export interface CompassControlOptions {
  readonly id?: string;
  readonly position?: ControlPosition;
  /** Heading change per arrow-key press, in degrees (default 15). */
  readonly keyStepDeg?: number;
  /** Heading change per CSS pixel of horizontal drag, in degrees (default 0.5). */
  readonly dragDegPerPx?: number;
}

/** Pointer travel, in CSS pixels, after which a press becomes a drag instead of a click. */
const DRAG_THRESHOLD_PX = 4;
const ORIENTATIONS: Readonly<Record<string, number>> = { n: 0, e: 90, s: 180, w: 270 };

/**
 * A compass: the needle shows north every frame. Click, tap, Enter or Space turn the map to north; dragging rotates it;
 * the arrow keys rotate by steps and N, E, S, W face that direction in one step.
 */
export class CompassControl implements UiControl {
  readonly id: string;
  readonly position: ControlPosition;
  readonly #keyStepDeg: number;
  readonly #dragDegPerPx: number;
  #context: ControlContext | undefined;
  #tween: CameraTween | undefined;
  #button: HTMLButtonElement | undefined;
  #needle: SVGSVGElement | undefined;
  #shownHeading = NaN;
  #stop: (() => void) | undefined;

  /** @param options - Placement and behavior; every field is optional. */
  constructor(options: CompassControlOptions = {}) {
    this.id = options.id ?? 'compass';
    this.position = options.position ?? 'top-right';
    this.#keyStepDeg = options.keyStepDeg ?? 15;
    this.#dragDegPerPx = options.dragDegPerPx ?? 0.5;
  }

  /** Builds the control's element (UiControl). */
  mount(context: ControlContext): HTMLElement {
    this.#context = context;
    const frame = controlFrame('compass');
    this.#needle = icon([ICONS.compassNorth, 'vg-ui__compass-north'], ICONS.compassSouth);
    this.#needle.classList.add('vg-ui__compass-needle');
    const button = iconButton('compass', this.#needle);
    this.#button = button;
    frame.append(button);
    this.#tween = new CameraTween(context.globe, context.container, context.reducedMotion);
    this.#bindPointer(button);
    button.addEventListener('keydown', (event) => this.#onKey(event));
    this.#stop = context.globe.on('camera-change', (camera) => this.#show(camera.headingDeg));
    this.#show(context.globe.camera.headingDeg);
    return frame;
  }

  /** Turns the map to face `headingDeg` (0 north, 90 east), animated. */
  faceHeading(headingDeg: number): void {
    this.#tween?.to({ headingDeg });
  }

  /** Turns the map to north, animated. */
  resetNorth(): void {
    this.faceHeading(0);
  }

  /** Updates texts and accessible names to the current language (UiControl). */
  localize(): void {
    this.#shownHeading = NaN;
    if (this.#context !== undefined) this.#show(this.#context.globe.camera.headingDeg);
  }

  /** Releases listeners and timers (UiControl). */
  destroy(): void {
    this.#stop?.();
    this.#tween?.destroy();
    this.#context = undefined;
  }

  #show(headingDeg: number): void {
    if (this.#needle === undefined || this.#button === undefined || this.#context === undefined) return;
    this.#needle.style.transform = `rotate(${-headingDeg}deg)`;
    const rounded = Math.round(((headingDeg % 360) + 360) % 360) % 360;
    if (rounded === this.#shownHeading) return;
    this.#shownHeading = rounded;
    const { i18n } = this.#context;
    const heading = `${i18n.formatNumber(rounded)}°`;
    label(this.#button, i18n.t('compass.label', { heading }), i18n.t('compass.title'));
  }

  #onKey(event: KeyboardEvent): void {
    const globe = this.#context?.globe;
    if (globe === undefined) return;
    const key = event.key.toLowerCase();
    const orientation = ORIENTATIONS[key];
    const from = this.#tween?.target?.headingDeg ?? globe.camera.headingDeg;
    if (orientation !== undefined) this.faceHeading(orientation);
    else if (key === 'arrowleft' || key === 'arrowdown') this.faceHeading(from - this.#keyStepDeg);
    else if (key === 'arrowright' || key === 'arrowup') this.faceHeading(from + this.#keyStepDeg);
    else return;
    event.preventDefault();
  }

  #bindPointer(button: HTMLButtonElement): void {
    let start: { x: number; heading: number; id: number } | undefined;
    let dragged = false;
    button.addEventListener('pointerdown', (event) => {
      const globe = this.#context?.globe;
      if (globe === undefined || event.button !== 0) return;
      this.#tween?.cancel();
      start = { x: event.clientX, heading: globe.camera.headingDeg, id: event.pointerId };
      dragged = false;
      button.setPointerCapture(event.pointerId);
    });
    button.addEventListener('pointermove', (event) => {
      if (start === undefined || event.pointerId !== start.id) return;
      const dx = event.clientX - start.x;
      if (!dragged && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      dragged = true;
      this.#context?.globe.jumpTo({ headingDeg: start.heading - dx * this.#dragDegPerPx });
    });
    const end = (event: PointerEvent): void => {
      if (start?.id === event.pointerId) start = undefined;
    };
    button.addEventListener('pointerup', end);
    button.addEventListener('pointercancel', end);
    button.addEventListener('click', (event) => {
      if (dragged) {
        dragged = false;
        event.preventDefault();
        return;
      }
      this.resetNorth();
    });
  }
}
