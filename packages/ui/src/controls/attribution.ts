/**
 * The attribution control (F424): the credits of the sources the last frame showed (`Globe.credits()`), updated on the
 * engine's `credits-change` event, which comes with the frame whose sources changed. On narrow maps it collapses to an
 * info button and the required logos; the button (mouse, touch, Enter or Space) expands the full list. Its links are
 * ordinary focusable links. The UI layer keeps every control clear of it and of the engine's own attribution element.
 */
import type { Credit } from '@vibeglobe/core';
import type { ControlContext, ControlPosition, UiControl } from '../ui.js';
import { controlFrame, icon, iconButton, ICONS, label } from './dom.js';

/** Options of {@link AttributionControl}. */
export interface AttributionControlOptions {
  readonly id?: string;
  readonly position?: ControlPosition;
  /** Maps narrower than this collapse the credits, in CSS pixels (default 640). */
  readonly compactBelowPx?: number;
}

/** The credit list, with an expand button on narrow maps. */
export class AttributionControl implements UiControl {
  readonly id: string;
  readonly position: ControlPosition;
  readonly #compactBelowPx: number;
  #context: ControlContext | undefined;
  #frame: HTMLElement | undefined;
  #list: HTMLElement | undefined;
  #toggle: HTMLButtonElement | undefined;
  #expanded = false;
  #compact = false;
  #stops: (() => void)[] = [];

  /** @param options - Placement and the compact width; every field is optional. */
  constructor(options: AttributionControlOptions = {}) {
    this.id = options.id ?? 'attribution';
    this.position = options.position ?? 'bottom-right';
    this.#compactBelowPx = options.compactBelowPx ?? 640;
  }

  /** Builds the control's element (UiControl). */
  mount(context: ControlContext): HTMLElement {
    this.#context = context;
    const frame = controlFrame('attribution');
    frame.setAttribute('role', 'contentinfo');
    const toggle = iconButton('attribution', icon(ICONS.info));
    toggle.setAttribute('aria-controls', `${this.id}-credits`);
    toggle.addEventListener('click', () => this.setExpanded(!this.#expanded));
    const list = document.createElement('ul');
    list.id = `${this.id}-credits`;
    list.className = 'vg-ui__attribution-list';
    frame.append(toggle, list);
    this.#frame = frame;
    this.#list = list;
    this.#toggle = toggle;
    this.#stops.push(context.globe.on('credits-change', ({ credits }) => this.#render(credits)));
    const resize = new ResizeObserver(() => this.#layout());
    resize.observe(context.container);
    this.#stops.push(() => resize.disconnect());
    this.#render(context.globe.credits());
    this.#layout();
    return frame;
  }

  /** Whether the full list shows (always on wide maps). */
  get expanded(): boolean {
    return !this.#compact || this.#expanded;
  }

  /** Expands or collapses the list on narrow maps. */
  setExpanded(expanded: boolean): void {
    this.#expanded = expanded;
    this.#layout();
  }

  /** Updates texts and accessible names to the current language (UiControl). */
  localize(): void {
    const i18n = this.#context?.i18n;
    if (i18n === undefined) return;
    this.#frame?.setAttribute('aria-label', i18n.t('attribution.label'));
    this.#layout();
  }

  /** Releases listeners (UiControl). */
  destroy(): void {
    for (const stop of this.#stops) stop();
    this.#stops = [];
    this.#context = undefined;
  }

  #layout(): void {
    const context = this.#context;
    if (context === undefined || this.#frame === undefined || this.#toggle === undefined) return;
    this.#compact = context.container.clientWidth < this.#compactBelowPx;
    this.#toggle.hidden = !this.#compact;
    this.#toggle.setAttribute('aria-expanded', String(this.expanded));
    label(this.#toggle, context.i18n.t(this.expanded ? 'attribution.collapse' : 'attribution.expand'));
    this.#frame.dataset['expanded'] = String(this.expanded);
  }

  #render(credits: readonly Credit[]): void {
    const list = this.#list;
    if (list === undefined || this.#frame === undefined) return;
    this.#frame.hidden = credits.length === 0;
    list.replaceChildren(
      ...credits.map((credit) => {
        const item = document.createElement('li');
        item.className = credit.required ? 'vg-ui__credit vg-ui__credit--required' : 'vg-ui__credit';
        if (credit.logo) {
          const logo = document.createElement('img');
          logo.className = 'vg-ui__credit-logo';
          logo.src = credit.logo.src;
          logo.alt = credit.logo.alt;
          item.append(logo);
        }
        const text = credit.url ? document.createElement('a') : document.createElement('span');
        text.className = 'vg-ui__credit-text';
        if (text instanceof HTMLAnchorElement && credit.url) {
          text.href = credit.url;
          text.target = '_blank';
          text.rel = 'noopener noreferrer';
        }
        text.textContent = credit.text;
        item.append(text);
        return item;
      }),
    );
  }
}
