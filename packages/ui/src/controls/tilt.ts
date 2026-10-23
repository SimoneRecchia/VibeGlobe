/**
 * The tilt control (F422): a vertical slider that sets the chosen tilt through the engine's `tiltTo` (F188), which
 * eases there and keeps it at every zoom (manual mode), and shows the applied tilt, marking when a temporary clamp
 * (terrain, empty sky, the Auto curve) holds it below the choice.
 */
import type { CameraState } from '@vibeglobe/core';
import type { ControlContext, ControlPosition, UiControl } from '../ui.js';
import { controlFrame } from './dom.js';

/** Options of {@link TiltControl}. */
export interface TiltControlOptions {
  readonly id?: string;
  readonly position?: ControlPosition;
  /** Tilt change per arrow-key press, in degrees (default 5); Page Up and Down move three steps. */
  readonly keyStepDeg?: number;
  /** The slider's largest tilt, in degrees (default 85: the engine caps it at its maximum tilt). */
  readonly maxTiltDeg?: number;
}

/** Below this the applied tilt counts as equal to the chosen one. */
const CLAMP_EPSILON_DEG = 0.5;

/** A slider: drag its track, click or tap a point of it, or use the arrow, Page and Home/End keys. */
export class TiltControl implements UiControl {
  readonly id: string;
  readonly position: ControlPosition;
  readonly #keyStepDeg: number;
  readonly #maxTiltDeg: number;
  #context: ControlContext | undefined;
  #slider: HTMLElement | undefined;
  #thumb: HTMLElement | undefined;
  #stop: (() => void) | undefined;
  #shown = '';
  /** The tilt the last input asked for, so key presses during an ease chain from it. */
  #target: number | undefined;

  /** @param options - Placement and behavior; every field is optional. */
  constructor(options: TiltControlOptions = {}) {
    this.id = options.id ?? 'tilt';
    this.position = options.position ?? 'top-right';
    this.#keyStepDeg = options.keyStepDeg ?? 5;
    this.#maxTiltDeg = options.maxTiltDeg ?? 85;
  }

  /** Builds the control's element (UiControl). */
  mount(context: ControlContext): HTMLElement {
    this.#context = context;
    const frame = controlFrame('tilt');
    const slider = document.createElement('div');
    slider.className = 'vg-ui__tilt-track';
    slider.tabIndex = 0;
    slider.setAttribute('role', 'slider');
    slider.setAttribute('aria-orientation', 'vertical');
    slider.setAttribute('aria-valuemin', '0');
    slider.setAttribute('aria-valuemax', String(this.#maxTiltDeg));
    const thumb = document.createElement('div');
    thumb.className = 'vg-ui__tilt-thumb';
    slider.append(thumb);
    frame.append(slider);
    this.#slider = slider;
    this.#thumb = thumb;
    slider.addEventListener('keydown', (event) => this.#onKey(event));
    this.#bindPointer(slider);
    this.#stop = context.globe.on('camera-change', (camera) => this.#show(camera));
    this.#show(context.globe.camera);
    return frame;
  }

  /** Sets the chosen tilt, eased by the engine; `immediate` moves in one frame (drags). */
  setTilt(tiltDeg: number, immediate = false): void {
    const globe = this.#context?.globe;
    if (globe === undefined || !Number.isFinite(tiltDeg)) return;
    const tilt = Math.min(this.#maxTiltDeg, Math.max(0, tiltDeg));
    this.#target = tilt;
    void globe.tiltTo(tilt, immediate || this.#context?.reducedMotion() === true ? { durationMs: 0 } : {}).then(() => {
      if (this.#target === tilt) this.#target = undefined;
    });
  }

  /** Updates texts and accessible names to the current language (UiControl). */
  localize(): void {
    const context = this.#context;
    if (context === undefined) return;
    this.#slider?.setAttribute('aria-label', context.i18n.t('tilt.label'));
    if (this.#slider !== undefined) this.#slider.title = context.i18n.t('tilt.title');
    this.#shown = '';
    this.#show(context.globe.camera);
  }

  /** Releases listeners (UiControl). */
  destroy(): void {
    this.#stop?.();
    this.#context = undefined;
  }

  #show(camera: CameraState): void {
    const context = this.#context;
    const slider = this.#slider;
    if (context === undefined || slider === undefined || this.#thumb === undefined) return;
    const applied = camera.tiltDeg;
    if (!Number.isFinite(applied)) return;
    const chosen = camera.chosenTiltDeg;
    // Clamped: the user chose a tilt (manual mode) and a limit holds the view below it.
    const clamped = camera.viewMode === 'manual' && chosen - applied > CLAMP_EPSILON_DEG;
    this.#thumb.style.setProperty('--vg-tilt-fraction', String(Math.min(1, applied / this.#maxTiltDeg)));
    const key = `${Math.round(applied)}|${clamped ? Math.round(chosen) : ''}|${context.i18n.language}`;
    if (key === this.#shown) return;
    this.#shown = key;
    const tilt = context.i18n.formatNumber(Math.round(applied));
    slider.setAttribute('aria-valuenow', String(Math.round(applied)));
    slider.setAttribute(
      'aria-valuetext',
      clamped
        ? context.i18n.t('tilt.clamped', { tilt, chosen: context.i18n.formatNumber(Math.round(chosen)) })
        : context.i18n.t('tilt.value', { tilt }),
    );
    slider.dataset['clamped'] = String(clamped);
  }

  #onKey(event: KeyboardEvent): void {
    const globe = this.#context?.globe;
    if (globe === undefined) return;
    const from = this.#target ?? globe.camera.chosenTiltDeg;
    const step = this.#keyStepDeg;
    const keys: Readonly<Record<string, number>> = {
      ArrowUp: from + step,
      ArrowRight: from + step,
      ArrowDown: from - step,
      ArrowLeft: from - step,
      PageUp: from + 3 * step,
      PageDown: from - 3 * step,
      Home: 0,
      End: this.#maxTiltDeg,
    };
    const tilt = keys[event.key];
    if (tilt === undefined) return;
    event.preventDefault();
    this.setTilt(tilt);
  }

  /** The tilt at a pointer's height on the track: 0° at the bottom, the maximum at the top. */
  #tiltAt(track: HTMLElement, clientY: number): number {
    const box = track.getBoundingClientRect();
    const fraction = box.height > 0 ? (box.bottom - clientY) / box.height : 0;
    return Math.min(1, Math.max(0, fraction)) * this.#maxTiltDeg;
  }

  #bindPointer(track: HTMLElement): void {
    let dragging: number | undefined;
    track.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      dragging = event.pointerId;
      track.setPointerCapture(event.pointerId);
      track.focus();
      // A press eases there; following moves of the drag apply at once, as the pointer moves.
      this.setTilt(this.#tiltAt(track, event.clientY));
      event.preventDefault();
    });
    track.addEventListener('pointermove', (event) => {
      if (dragging !== event.pointerId) return;
      this.setTilt(this.#tiltAt(track, event.clientY), true);
    });
    const end = (event: PointerEvent): void => {
      if (dragging === event.pointerId) dragging = undefined;
    };
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
  }
}
