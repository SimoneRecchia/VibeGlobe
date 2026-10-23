/**
 * The scale bar (F412): the geodesic ground length of a horizontal screen line through the view center, measured on
 * every drawn camera change from the engine's own `screenToGeo`, so it stays right in the globe, 2D and tilted 3D
 * phases. The bar shows a round length (1, 2 or 5 times a power of ten) no wider than its maximum width.
 */
import { formatLength, measureDistance } from '@vibeglobe/gis';
import type { Globe } from '@vibeglobe/core';
import type { ControlContext, ControlPosition, UiControl } from '../ui.js';
import { controlFrame } from './dom.js';

/** Options of {@link ScaleBarControl}. */
export interface ScaleBarControlOptions {
  readonly id?: string;
  readonly position?: ControlPosition;
  /** The bar's largest width, in CSS pixels (default 100). */
  readonly maxWidthPx?: number;
}

/** The scale at the view center: ground meters per CSS pixel along the screen's horizontal. */
export interface ScaleMeasurement {
  readonly metersPerPx: number;
  /** The round length the bar shows, and its width in CSS pixels. */
  readonly lengthMeters: number;
  readonly widthPx: number;
}

/** The largest round length (1, 2 or 5 × 10ⁿ meters) not above `meters`. */
export function roundLength(meters: number): number {
  const power = 10 ** Math.floor(Math.log10(meters));
  const leading = meters / power;
  return (leading >= 5 ? 5 : leading >= 2 ? 2 : 1) * power;
}

/**
 * Measures the scale at the screen point `center` of `globe`'s view: the geodesic distance between the points shown
 * `halfWidthPx` to its left and right (halved while one is off the globe), over the screen length between them.
 * Undefined when nothing of the globe is shown there.
 */
export function measureScale(
  globe: Globe,
  center: { readonly xPx: number; readonly yPx: number },
  maxWidthPx: number,
): ScaleMeasurement | undefined {
  for (let half = maxWidthPx / 2; half >= 2; half /= 2) {
    const left = globe.screenToGeo({ xPx: center.xPx - half, yPx: center.yPx });
    const right = globe.screenToGeo({ xPx: center.xPx + half, yPx: center.yPx });
    if (left === undefined || right === undefined) continue;
    const meters = measureDistance(left, right).distanceMeters;
    if (!(meters > 0)) return undefined;
    const metersPerPx = meters / (2 * half);
    const lengthMeters = roundLength(metersPerPx * maxWidthPx);
    return { metersPerPx, lengthMeters, widthPx: lengthMeters / metersPerPx };
  }
  return undefined;
}

/** A bar and its length; focusable, with the scale as its accessible name. */
export class ScaleBarControl implements UiControl {
  readonly id: string;
  readonly position: ControlPosition;
  readonly #maxWidthPx: number;
  #context: ControlContext | undefined;
  #frame: HTMLElement | undefined;
  #bar: HTMLElement | undefined;
  #text: HTMLElement | undefined;
  #stop: (() => void) | undefined;
  #shown = '';
  #measurement: ScaleMeasurement | undefined;

  /** @param options - Placement and width; every field is optional. */
  constructor(options: ScaleBarControlOptions = {}) {
    this.id = options.id ?? 'scale';
    this.position = options.position ?? 'bottom-left';
    this.#maxWidthPx = options.maxWidthPx ?? 100;
  }

  /** The last measurement, undefined while nothing of the globe is under the view center. */
  get measurement(): ScaleMeasurement | undefined {
    return this.#measurement;
  }

  /** Builds the control's element (UiControl). */
  mount(context: ControlContext): HTMLElement {
    this.#context = context;
    const frame = controlFrame('scale');
    frame.tabIndex = 0;
    frame.setAttribute('role', 'img');
    const bar = document.createElement('div');
    bar.className = 'vg-ui__scale-bar';
    const text = document.createElement('span');
    text.className = 'vg-ui__scale-text';
    text.setAttribute('aria-hidden', 'true');
    frame.append(text, bar);
    this.#frame = frame;
    this.#bar = bar;
    this.#text = text;
    // The camera event comes once per drawn frame, before the frame is shown: the bar updates in the same frame.
    this.#stop = context.globe.on('camera-change', () => this.update());
    queueMicrotask(() => this.update());
    return frame;
  }

  /** Measures the scale of the current view and shows it. */
  update(): void {
    const context = this.#context;
    if (context === undefined || this.#bar === undefined || this.#text === undefined || this.#frame === undefined)
      return;
    const { container, globe, i18n } = context;
    const center = { xPx: container.clientWidth / 2, yPx: container.clientHeight / 2 };
    const measurement = measureScale(globe, center, this.#maxWidthPx);
    this.#measurement = measurement;
    this.#frame.hidden = measurement === undefined;
    if (measurement === undefined) return;
    this.#bar.style.width = `${measurement.widthPx}px`;
    const length = formatLength(measurement.lengthMeters, i18n.language);
    if (length === this.#shown) return;
    this.#shown = length;
    this.#text.textContent = length;
    this.#frame.setAttribute('aria-label', i18n.t('scale.label', { length }));
  }

  /** Updates texts to the current language (UiControl). */
  localize(): void {
    this.#shown = '';
    this.update();
  }

  /** Releases listeners (UiControl). */
  destroy(): void {
    this.#stop?.();
    this.#context = undefined;
  }
}
