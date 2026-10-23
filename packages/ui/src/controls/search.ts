/**
 * The search box (F426): typed coordinates in every format of `@vibeglobe/gis` (F405), and places from the
 * application's geocoder when one is configured; none is bundled and no request is made without one.
 */
import { formatCoordinate, parseCoordinate, parseCoordinateResult } from '@vibeglobe/gis';
import type { GeoBounds, Geocoder, GeocoderResult, Globe } from '@vibeglobe/core';
import type { ControlContext, ControlPosition, UiControl } from '../ui.js';
import { controlFrame } from './dom.js';
import { decimalSeparator } from './locale.js';

/** The engine's geocoder interface (F208), re-exported for the search box's users. */
export type { Geocoder, GeocoderResult };

/** Moves the camera to a chosen place; by default a flight (F195), or a fit of the place's bounds when it has some. */
export type GoTo = (
  globe: Globe,
  target: { longitudeDeg: number; latitudeDeg: number; zoom: number; bounds?: GeoBounds },
) => void;

/** Options of {@link SearchControl}. */
export interface SearchControlOptions {
  readonly id?: string;
  readonly position?: ControlPosition;
  readonly geocoder?: Geocoder;
  /** Delay after the last keystroke before the geocoder is asked, in milliseconds (default 250). */
  readonly debounceMs?: number;
  /** Zoom for typed coordinates and results without one (default 12). */
  readonly zoom?: number;
  readonly goTo?: GoTo;
}

/** Messages under the search box. */
type StatusKey =
  | 'search.coordinatesOnly'
  | 'search.searching'
  | 'search.noResults'
  | 'search.failed'
  | 'search.invalid.latitude-out-of-range'
  | 'search.invalid.longitude-out-of-range'
  | 'search.invalid.invalid-utm-zone'
  | 'search.invalid.invalid-minutes-or-seconds';

const fly: GoTo = (globe, target) =>
  void (target.bounds
    ? globe.fitBounds(target.bounds, { paddingPx: 20 })
    : globe.flyTo({ longitudeDeg: target.longitudeDeg, latitudeDeg: target.latitudeDeg, zoom: target.zoom }));
let instances = 0;

/** A combobox: type, move through the results with the arrow keys, choose with Enter, a click or a tap. */
export class SearchControl implements UiControl {
  readonly id: string;
  readonly position: ControlPosition;
  readonly #geocoder: Geocoder | undefined;
  readonly #debounceMs: number;
  readonly #zoom: number;
  readonly #goTo: GoTo;
  readonly #prefix = `vg-ui-search-${++instances}`;
  #context: ControlContext | undefined;
  #input: HTMLInputElement | undefined;
  #list: HTMLUListElement | undefined;
  #status: HTMLElement | undefined;
  #results: GeocoderResult[] = [];
  #active = -1;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #abort: AbortController | undefined;
  #statusKey: StatusKey | undefined;

  /** @param options - Placement and behavior; every field is optional. */
  constructor(options: SearchControlOptions = {}) {
    this.id = options.id ?? 'search';
    this.position = options.position ?? 'top-left';
    this.#geocoder = options.geocoder;
    this.#debounceMs = options.debounceMs ?? 250;
    this.#zoom = options.zoom ?? 12;
    this.#goTo = options.goTo ?? fly;
  }

  /** Builds the control's element (UiControl). */
  mount(context: ControlContext): HTMLElement {
    this.#context = context;
    const frame = controlFrame('search');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'vg-ui__search-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', `${this.#prefix}-list`);
    const list = document.createElement('ul');
    list.id = `${this.#prefix}-list`;
    list.className = 'vg-ui__search-list';
    list.setAttribute('role', 'listbox');
    const status = document.createElement('div');
    status.className = 'vg-ui__search-status';
    status.setAttribute('role', 'status');
    frame.append(input, list, status);
    this.#input = input;
    this.#list = list;
    this.#status = status;
    input.addEventListener('input', () => this.#onInput());
    input.addEventListener('keydown', (event) => this.#onKey(event));
    return frame;
  }

  /** Updates texts and accessible names to the current language (UiControl). */
  localize(): void {
    const i18n = this.#context?.i18n;
    if (i18n === undefined || this.#input === undefined) return;
    this.#input.placeholder = i18n.t('search.placeholder');
    this.#input.setAttribute('aria-label', i18n.t('search.label'));
    this.#list?.setAttribute('aria-label', i18n.t('search.results'));
    this.#renderStatus();
    if (this.#input.value.trim() !== '') this.#update(this.#results);
  }

  /** Chooses the result at `index` of the list: goes there and closes the list. */
  choose(index: number): void {
    const context = this.#context;
    const result = this.#options()[index];
    if (context === undefined || result === undefined) return;
    this.#goTo(context.globe, {
      longitudeDeg: result.longitudeDeg,
      latitudeDeg: result.latitudeDeg,
      zoom: result.zoom ?? this.#zoom,
      ...(result.bounds ? { bounds: result.bounds } : {}),
    });
    this.#results = [];
    this.#close();
  }

  /** Releases listeners and timers (UiControl). */
  destroy(): void {
    clearTimeout(this.#timer);
    this.#abort?.abort();
    this.#context = undefined;
  }

  /** The listed options: a typed coordinate first, then the geocoder's places. */
  #options(): GeocoderResult[] {
    const context = this.#context;
    const text = this.#input?.value ?? '';
    const position = parseCoordinate(text);
    if (context === undefined || position === undefined) return this.#results;
    const shown = formatCoordinate(position, 'decimal', { decimalSeparator: decimalSeparator(context.i18n.language) });
    const coordinates = context.i18n.t('search.coordinateResult', { coordinates: shown ?? text });
    return [{ label: coordinates, ...position }, ...this.#results];
  }

  #onInput(): void {
    clearTimeout(this.#timer);
    this.#abort?.abort();
    this.#results = [];
    const query = this.#input?.value.trim() ?? '';
    const parsed = parseCoordinateResult(query);
    const isCoordinate = parsed.position !== undefined;
    // A coordinate typed wrong (latitude 95, zone 61…) says why, and nothing moves (F207).
    const code = parsed.error?.code;
    if (query !== '' && code !== undefined && code !== 'unrecognized') this.#setStatus(`search.invalid.${code}`);
    else if (query === '') this.#setStatus(undefined);
    else if (this.#geocoder === undefined || isCoordinate)
      this.#setStatus(isCoordinate ? undefined : 'search.coordinatesOnly');
    else {
      this.#setStatus('search.searching');
      this.#timer = setTimeout(() => void this.#search(query), this.#debounceMs);
    }
    this.#update([]);
  }

  async #search(query: string): Promise<void> {
    const geocoder = this.#geocoder;
    const language = this.#context?.i18n.language ?? 'en';
    if (geocoder === undefined) return;
    const abort = new AbortController();
    this.#abort = abort;
    try {
      const results = await geocoder.search(query, { signal: abort.signal, language });
      if (abort.signal.aborted) return;
      this.#results = [...results];
      this.#setStatus(results.length === 0 ? 'search.noResults' : undefined);
    } catch {
      if (abort.signal.aborted) return;
      this.#results = [];
      this.#setStatus('search.failed');
    }
    this.#update(this.#results);
  }

  #update(results: readonly GeocoderResult[]): void {
    const list = this.#list;
    const input = this.#input;
    if (list === undefined || input === undefined) return;
    this.#results = [...results];
    const options = this.#options();
    list.replaceChildren(
      ...options.map((result, index) => {
        const item = document.createElement('li');
        item.id = `${this.#prefix}-option-${index}`;
        item.className = 'vg-ui__search-option';
        item.setAttribute('role', 'option');
        item.textContent = result.label;
        // Chosen on pointerdown, before the input's blur could close the list.
        item.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          this.choose(index);
        });
        return item;
      }),
    );
    this.#active = options.length > 0 ? 0 : -1;
    input.setAttribute('aria-expanded', String(options.length > 0));
    this.#highlight();
  }

  #onKey(event: KeyboardEvent): void {
    const count = this.#list?.children.length ?? 0;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (count === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      this.#active = (this.#active + step + count) % count;
      this.#highlight();
    } else if (event.key === 'Enter') {
      if (this.#active < 0) return;
      this.choose(this.#active);
    } else if (event.key === 'Escape') {
      if (this.#input !== undefined) this.#input.value = '';
      this.#onInput();
    } else return;
    event.preventDefault();
  }

  #highlight(): void {
    const input = this.#input;
    if (input === undefined || this.#list === undefined) return;
    for (const [index, item] of [...this.#list.children].entries())
      item.setAttribute('aria-selected', String(index === this.#active));
    if (this.#active < 0) input.removeAttribute('aria-activedescendant');
    else input.setAttribute('aria-activedescendant', `${this.#prefix}-option-${this.#active}`);
  }

  #close(): void {
    this.#list?.replaceChildren();
    this.#active = -1;
    this.#input?.setAttribute('aria-expanded', 'false');
    this.#input?.removeAttribute('aria-activedescendant');
    this.#setStatus(undefined);
  }

  #setStatus(key: StatusKey | undefined): void {
    this.#statusKey = key;
    this.#renderStatus();
  }

  #renderStatus(): void {
    if (this.#status === undefined || this.#context === undefined) return;
    this.#status.textContent = this.#statusKey === undefined ? '' : this.#context.i18n.t(this.#statusKey);
  }
}
