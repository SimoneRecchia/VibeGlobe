/**
 * The coordinates readout (F406): the position and elevation under the pointer, or at the view center while the map
 * is navigated with the keyboard, in the chosen format. Formatting comes from `@vibeglobe/gis` (F405).
 */
import type { GeoPosition } from '@vibeglobe/core';
import { formatCoordinate, type CoordinateFormat } from '@vibeglobe/gis';
import type { ControlContext, ControlPosition, UiControl } from '../ui.js';
import { controlFrame, icon, iconButton, ICONS, label } from './dom.js';
import { decimalSeparator } from './locale.js';

/**
 * Terrain elevation at a position, in meters, or undefined where unknown. A stub until the engine exposes terrain
 * heights (F383; docs/parallel-tracks.md): without it the readout shows the elevation as unknown.
 */
export type ElevationProvider = (position: GeoPosition) => number | undefined;

/** Options of {@link CoordinateReadoutControl}. */
export interface CoordinateReadoutOptions {
  readonly id?: string;
  readonly position?: ControlPosition;
  /** The initial format (default 'decimal'). */
  readonly format?: CoordinateFormat;
  /** Decimal places per format (defaults of `formatCoordinate`). */
  readonly precision?: Partial<Record<CoordinateFormat, number>>;
  readonly elevationAt?: ElevationProvider;
}

const FORMATS: readonly CoordinateFormat[] = ['decimal', 'dms', 'utm'];
const FORMAT_NAMES = {
  decimal: 'readout.format.decimal',
  dms: 'readout.format.dms',
  utm: 'readout.format.utm',
} as const satisfies Record<CoordinateFormat, string>;

/** Shows coordinates live; its button (or the F key while it has focus) switches the format. */
export class CoordinateReadoutControl implements UiControl {
  readonly id: string;
  readonly position: ControlPosition;
  readonly #precision: Partial<Record<CoordinateFormat, number>>;
  readonly #elevationAt: ElevationProvider | undefined;
  #format: CoordinateFormat;
  #context: ControlContext | undefined;
  #coordinates: HTMLElement | undefined;
  #detail: HTMLElement | undefined;
  #button: HTMLButtonElement | undefined;
  #frame: HTMLElement | undefined;
  #source: 'pointer' | 'center' = 'center';
  #pointer: { xPx: number; yPx: number } | undefined;
  #scheduled = 0;
  #cleanup: (() => void)[] = [];

  /** @param options - Placement and behavior; every field is optional. */
  constructor(options: CoordinateReadoutOptions = {}) {
    this.id = options.id ?? 'readout';
    this.position = options.position ?? 'bottom-left';
    this.#format = options.format ?? 'decimal';
    this.#precision = options.precision ?? {};
    this.#elevationAt = options.elevationAt;
  }

  /** The current format. */
  get format(): CoordinateFormat {
    return this.#format;
  }

  /** Switches the format. */
  setFormat(format: CoordinateFormat): void {
    this.#format = format;
    this.localize();
  }

  /** Builds the control's element (UiControl). */
  mount(context: ControlContext): HTMLElement {
    this.#context = context;
    const frame = controlFrame('readout');
    frame.setAttribute('role', 'group');
    this.#frame = frame;
    const text = document.createElement('div');
    text.className = 'vg-ui__readout-text';
    this.#coordinates = document.createElement('span');
    this.#coordinates.className = 'vg-ui__readout-coordinates';
    this.#detail = document.createElement('span');
    this.#detail.className = 'vg-ui__readout-detail';
    text.append(this.#coordinates, this.#detail);
    const button = iconButton('readout-format', icon(ICONS.format));
    this.#button = button;
    button.addEventListener('click', () => {
      this.setFormat(FORMATS[(FORMATS.indexOf(this.#format) + 1) % FORMATS.length] ?? 'decimal');
    });
    frame.append(text, button);
    this.#listen(context);
    return frame;
  }

  /** Updates texts and accessible names to the current language (UiControl). */
  localize(): void {
    const context = this.#context;
    if (context === undefined || this.#button === undefined) return;
    const format = context.i18n.t(FORMAT_NAMES[this.#format]);
    label(this.#button, context.i18n.t('readout.format', { format }));
    this.#frame?.setAttribute('aria-label', context.i18n.t('readout.label'));
    this.#render();
  }

  /** Releases listeners and timers (UiControl). */
  destroy(): void {
    if (this.#scheduled !== 0) cancelAnimationFrame(this.#scheduled);
    for (const stop of this.#cleanup) stop();
    this.#cleanup = [];
    this.#context = undefined;
  }

  #listen(context: ControlContext): void {
    const { container, globe } = context;
    const fromEvent = (event: PointerEvent): void => {
      // Pointer input over the controls themselves leaves the readout as it is.
      if (event.target instanceof Element && event.target.closest('.vg-ui__control') !== null) return;
      const rect = container.getBoundingClientRect();
      this.#source = 'pointer';
      this.#pointer = { xPx: event.clientX - rect.left, yPx: event.clientY - rect.top };
      this.#schedule();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.target instanceof Element && event.target.closest('.vg-ui') !== null) return;
      this.#source = 'center';
      this.#schedule();
    };
    container.addEventListener('pointermove', fromEvent);
    // A tap or long-press on a touch screen shows the touched point.
    container.addEventListener('pointerdown', fromEvent);
    container.addEventListener('keydown', onKey);
    const stopCamera = globe.on('camera-change', () => this.#schedule());
    this.#cleanup.push(
      () => container.removeEventListener('pointermove', fromEvent),
      () => container.removeEventListener('pointerdown', fromEvent),
      () => container.removeEventListener('keydown', onKey),
      stopCamera,
    );
  }

  /** Coalesces updates to one per display frame. */
  #schedule(): void {
    if (this.#scheduled !== 0) return;
    this.#scheduled = requestAnimationFrame(() => {
      this.#scheduled = 0;
      this.#render();
    });
  }

  #render(): void {
    const context = this.#context;
    if (context === undefined || this.#coordinates === undefined || this.#detail === undefined) return;
    const { globe, i18n } = context;
    const camera = globe.camera;
    const position: GeoPosition | undefined =
      this.#source === 'pointer' && this.#pointer !== undefined
        ? globe.screenToGeo(this.#pointer)
        : Number.isFinite(camera.latitudeDeg)
          ? { longitudeDeg: camera.longitudeDeg, latitudeDeg: camera.latitudeDeg }
          : undefined;
    const where = i18n.t(this.#source === 'pointer' ? 'readout.pointer' : 'readout.center');
    if (position === undefined) {
      this.#coordinates.textContent = i18n.t('readout.none');
      this.#detail.textContent = where;
      return;
    }
    const options = { decimalSeparator: decimalSeparator(i18n.language) };
    const precision = this.#precision[this.#format];
    this.#coordinates.textContent =
      formatCoordinate(position, this.#format, precision === undefined ? options : { ...options, precision }) ??
      formatCoordinate(position, 'decimal', options) ??
      '';
    const elevation = this.#elevationAt?.(position);
    const height =
      elevation === undefined
        ? i18n.t('readout.noElevation')
        : i18n.t('readout.elevation', { elevation: `${i18n.formatNumber(Math.round(elevation))} m` });
    this.#detail.textContent = `${where} · ${height}`;
  }
}
