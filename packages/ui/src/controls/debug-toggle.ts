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
  }

  /** Releases listeners and timers (UiControl). */
  destroy(): void {
    this.#hide();
    this.#context = undefined;
  }

  #show(context: ControlContext): void {
    const { globe } = context;
    // The panel sits above the button, in the same corner's flow, so it covers no other control.
    const overlay = createDebugOverlay(this.#frame?.parentElement ?? context.container, context.i18n.t('debug.panel'));
    this.#overlay = overlay;
    const stats = new FrameStats();
    let lastRefreshMs = -Infinity;
    this.#stopFrames = globe.on('frame', () => {
      const nowMs = performance.now();
      stats.recordFrame(nowMs);
      if (nowMs - lastRefreshMs < REFRESH_MS) return;
      lastRefreshMs = nowMs;
      overlay.update({ frameTimeMs: stats.meanFrameTimeMs, framesPerSecond: stats.framesPerSecond });
      const surface = globe.surfaceStats();
      const renderer = globe.rendererStats();
      const imagery = globe.imageryStats();
      const mb = (bytes: number): string => (bytes / 1048576).toFixed(1);
      overlay.setInfo([
        ['backend', `backend ${globe.backend ?? '–'}`],
        ['surface', `tiles ${surface.tiles} · level ≤ ${surface.maxLevel}`],
        ['draws', `draw calls ${renderer.drawCalls} · triangles ${renderer.triangles}`],
        ...(imagery === undefined
          ? []
          : ([
              [
                'imagery',
                `GPU ${mb(imagery.gpuBytes)} MB · RAM ${mb(imagery.ramBytes)} MB · loading ${imagery.loading}`,
              ],
            ] as const)),
      ]);
    });
    globe.requestRender();
  }

  #hide(): void {
    this.#stopFrames?.();
    this.#stopFrames = undefined;
    this.#overlay?.destroy();
    this.#overlay = undefined;
  }
}
