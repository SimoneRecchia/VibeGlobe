/** The fullscreen control (F427). */
import type { ControlContext, ControlPosition, UiControl } from '../ui.js';
import { controlFrame, icon, iconButton, ICONS, label } from './dom.js';

/** Options of {@link FullscreenControl}. */
export interface FullscreenControlOptions {
  readonly id?: string;
  readonly position?: ControlPosition;
}

/** Puts the map container in and out of fullscreen; hidden where the Fullscreen API is unavailable. */
export class FullscreenControl implements UiControl {
  readonly id: string;
  readonly position: ControlPosition;
  #context: ControlContext | undefined;
  #button: HTMLButtonElement | undefined;
  #stop: (() => void) | undefined;

  /** @param options - Placement and behavior; every field is optional. */
  constructor(options: FullscreenControlOptions = {}) {
    this.id = options.id ?? 'fullscreen';
    this.position = options.position ?? 'top-right';
  }

  /** Builds the control's element (UiControl). */
  mount(context: ControlContext): HTMLElement {
    this.#context = context;
    const frame = controlFrame('fullscreen');
    const button = iconButton('fullscreen', icon(ICONS.enterFullscreen));
    this.#button = button;
    frame.append(button);
    frame.hidden = !document.fullscreenEnabled || typeof context.container.requestFullscreen !== 'function';
    button.addEventListener('click', () => void this.toggle());
    const onChange = (): void => this.localize();
    document.addEventListener('fullscreenchange', onChange);
    this.#stop = () => document.removeEventListener('fullscreenchange', onChange);
    return frame;
  }

  /** Whether the map container is the fullscreen element. */
  get active(): boolean {
    return this.#context !== undefined && document.fullscreenElement === this.#context.container;
  }

  /** Enters or leaves fullscreen. */
  async toggle(): Promise<void> {
    const container = this.#context?.container;
    if (container === undefined) return;
    if (this.active) await document.exitFullscreen();
    else await container.requestFullscreen();
  }

  /** Updates texts and accessible names to the current language (UiControl). */
  localize(): void {
    const i18n = this.#context?.i18n;
    const button = this.#button;
    if (i18n === undefined || button === undefined) return;
    const active = this.active;
    button.setAttribute('aria-pressed', String(active));
    button.replaceChildren(icon(active ? ICONS.exitFullscreen : ICONS.enterFullscreen));
    label(button, i18n.t('fullscreen.label'), i18n.t(active ? 'fullscreen.exit' : 'fullscreen.enter'));
  }

  /** Releases listeners and timers (UiControl). */
  destroy(): void {
    this.#stop?.();
    this.#context = undefined;
  }
}
