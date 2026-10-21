/** The debug panel toggle (F428): shows and hides the debug overlay with the performance HUD. */
import { FrameStats } from '@vibeglobe/core';
import { createDebugOverlay, type DebugOverlay } from '../debug/debug-overlay.js';
import type { ControlContext, ControlPosition, UiControl } from '../ui.js';
import { controlFrame, icon, iconButton, ICONS, label } from './dom.js';

/** Options of {@link DebugToggleControl}. */
export interface DebugToggleControlOptions {
  readonly id?: string;
  readonly position?: ControlPosition;
}

/** How often the panel's figures refresh, in milliseconds. */
const REFRESH_MS = 250;

/**
 * A button that shows the debug panel: the performance HUD (frame time and rate) and engine diagnostics (backend,
 * surface tiles, draw calls, imagery cache). Add it only where debugging is wanted (`addDefaultControls` adds it when
 * its `debug` option is set).
 */
export class DebugToggleControl implements UiControl {
  readonly id: string;
  readonly position: ControlPosition;
  #context: ControlContext | undefined;
  #button: HTMLButtonElement | undefined;
  #frame: HTMLElement | undefined;
  #overlay: DebugOverlay | undefined;
  #stopFrames: (() => void) | undefined;
  #refresh: (() => void) | undefined;

  /** @param options - Placement and behavior; every field is optional. */
  constructor(options: DebugToggleControlOptions = {}) {
    this.id = options.id ?? 'debug';
    this.position = options.position ?? 'bottom-left';
  }

  /** Builds the control's element (UiControl). */
  mount(context: ControlContext): HTMLElement {
    this.#context = context;
    const frame = controlFrame('debug');
    const button = iconButton('debug', icon(ICONS.debug));
    this.#frame = frame;
    this.#button = button;
    frame.append(button);
    button.addEventListener('click', () => this.setVisible(this.#overlay === undefined));
    return frame;
  }

  /** Whether the panel is shown. */
  get visible(): boolean {
    return this.#overlay !== undefined;
  }

  /** Shows or hides the panel. */
  setVisible(visible: boolean): void {
    const context = this.#context;
    if (context === undefined || visible === this.visible) return;
    if (visible) this.#show(context);
    else this.#hide();
    this.localize();
  }

  /** Updates texts and accessible names to the current language (UiControl). */
  localize(): void {
    const i18n = this.#context?.i18n;
    if (i18n === undefined || this.#button === undefined) return;
    this.#button.setAttribute('aria-pressed', String(this.visible));
    label(this.#button, i18n.t('debug.label'), i18n.t(this.visible ? 'debug.hide' : 'debug.show'));
    this.#frame?.parentElement
      ?.querySelector('.vibeglobe-debug-overlay')
      ?.setAttribute('aria-label', i18n.t('debug.panel'));
    this.#refresh?.();
  }

  /** Releases listeners and timers (UiControl). */
  destroy(): void {
    this.#hide();
    this.#context = undefined;
  }

  #show(context: ControlContext): void {
    const { globe, i18n } = context;
    const figure = (value: number | undefined, digits = 1): string =>
      value === undefined
        ? '–'
        : i18n.formatNumber(value, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    // The panel sits above the button, in the same corner's flow, so it covers no other control.
    const overlay = createDebugOverlay(
      this.#frame?.parentElement ?? context.container,
      i18n.t('debug.panel'),
      (metric, value) =>
        i18n.t(metric === 'frame-time' ? 'debug.frameTime' : 'debug.frameRate', { value: figure(value) }),
    );
    this.#overlay = overlay;
    const stats = new FrameStats();
    let lastRefreshMs = -Infinity;
    const refresh = (): void => {
      overlay.update({ frameTimeMs: stats.meanFrameTimeMs, framesPerSecond: stats.framesPerSecond });
      const surface = globe.surfaceStats();
      const renderer = globe.rendererStats();
      const imagery = globe.imageryStats();
      const mb = (bytes: number): string => figure(bytes / 1048576);
      overlay.setInfo([
        ['backend', i18n.t('debug.backend', { backend: globe.backend ?? '–' })],
        ['surface', i18n.t('debug.surface', { tiles: figure(surface.tiles, 0), level: figure(surface.maxLevel, 0) })],
        [
          'draws',
          i18n.t('debug.draws', { calls: figure(renderer.drawCalls, 0), triangles: figure(renderer.triangles, 0) }),
        ],
        ...(imagery === undefined
          ? []
          : ([
              [
                'imagery',
                i18n.t('debug.imagery', {
                  gpu: mb(imagery.gpuBytes),
                  ram: mb(imagery.ramBytes),
                  loading: figure(imagery.loading, 0),
                }),
              ],
            ] as const)),
      ]);
    };
    this.#refresh = refresh;
    this.#stopFrames = globe.on('frame', () => {
      const nowMs = performance.now();
      stats.recordFrame(nowMs);
      if (nowMs - lastRefreshMs < REFRESH_MS) return;
      lastRefreshMs = nowMs;
      refresh();
    });
    refresh();
    globe.requestRender();
  }

  #hide(): void {
    this.#stopFrames?.();
    this.#stopFrames = undefined;
    this.#overlay?.destroy();
    this.#overlay = undefined;
    this.#refresh = undefined;
  }
}
