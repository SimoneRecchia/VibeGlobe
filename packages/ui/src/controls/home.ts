// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The reset-to-globe and home-view buttons (F423): flights through the engine's `resetToGlobe` (F193) and `goHome`
 * (F194), which follow the view-mode rules, fade under reduced motion (F214) and yield to any user input.
 */
import type { ControlContext, ControlPosition, UiControl } from '../ui.js';
import { controlFrame, icon, iconButton, ICONS, label } from './dom.js';

/** Options of {@link HomeControl}. */
export interface HomeControlOptions {
  readonly id?: string;
  readonly position?: ControlPosition;
  /** Shows the reset-to-globe button (default true). */
  readonly globe?: boolean;
  /** Shows the home-view button (default true). */
  readonly home?: boolean;
}

/** One or two buttons: the whole globe, and the project's home view. */
export class HomeControl implements UiControl {
  readonly id: string;
  readonly position: ControlPosition;
  readonly #showGlobe: boolean;
  readonly #showHome: boolean;
  #context: ControlContext | undefined;
  #globeButton: HTMLButtonElement | undefined;
  #homeButton: HTMLButtonElement | undefined;

  /** @param options - Placement and buttons; every field is optional. */
  constructor(options: HomeControlOptions = {}) {
    this.id = options.id ?? 'home';
    this.position = options.position ?? 'top-right';
    this.#showGlobe = options.globe ?? true;
    this.#showHome = options.home ?? true;
  }

  /** Builds the control's element (UiControl). */
  mount(context: ControlContext): HTMLElement {
    this.#context = context;
    const frame = controlFrame('home');
    frame.setAttribute('role', 'group');
    if (this.#showGlobe) {
      this.#globeButton = iconButton('reset-globe', icon(ICONS.globe));
      this.#globeButton.addEventListener('click', () => this.resetToGlobe());
      frame.append(this.#globeButton);
    }
    if (this.#showHome) {
      this.#homeButton = iconButton('home', icon(ICONS.home));
      this.#homeButton.addEventListener('click', () => this.goHome());
      frame.append(this.#homeButton);
    }
    return frame;
  }

  /** Flies out to the whole globe. */
  resetToGlobe(): void {
    void this.#context?.globe.resetToGlobe();
  }

  /** Flies to the home view. */
  goHome(): void {
    void this.#context?.globe.goHome();
  }

  /** Updates texts and accessible names to the current language (UiControl). */
  localize(): void {
    const i18n = this.#context?.i18n;
    if (i18n === undefined) return;
    if (this.#globeButton !== undefined) label(this.#globeButton, i18n.t('home.globe'));
    if (this.#homeButton !== undefined) label(this.#homeButton, i18n.t('home.home'));
  }

  /** Nothing to release (UiControl). */
  destroy(): void {
    this.#context = undefined;
  }
}
