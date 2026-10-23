/**
 * Saved views (F415): bookmarks of the camera (`@vibeglobe/gis` view states, F414) created, listed, opened (a flight,
 * F195) and removed through the API and a panel, exported and imported as JSON. With `storageKey` they persist in the
 * browser's local storage.
 */
import { viewStateFromJson, viewStateOf, viewStateToJson, type ViewState } from '@vibeglobe/gis';
import type { ControlContext, ControlPosition, UiControl } from '../ui.js';
import { applyViewState } from '../view-state.js';
import { controlFrame, icon, iconButton, ICONS, label } from './dom.js';

/** A saved view. */
export interface Bookmark {
  readonly id: string;
  readonly name: string;
  readonly view: ViewState;
}

/** Options of {@link BookmarksControl}. */
export interface BookmarksControlOptions {
  readonly id?: string;
  readonly position?: ControlPosition;
  /** Keeps the bookmarks in `localStorage` under this key; without it they live as long as the control. */
  readonly storageKey?: string;
  /** Bookmarks to start with (ignored when the storage already holds some). */
  readonly bookmarks?: readonly Bookmark[];
}

let instances = 0;

/** Reads bookmarks from JSON text, or undefined when it is not a list of valid bookmarks. */
function parseBookmarks(json: string): Bookmark[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const bookmarks: Bookmark[] = [];
  for (const entry of parsed as unknown[]) {
    if (entry === null || typeof entry !== 'object') return undefined;
    const { id, name, view } = entry as Record<string, unknown>;
    const state = viewStateFromJson(JSON.stringify(view));
    if (typeof id !== 'string' || typeof name !== 'string' || state === undefined) return undefined;
    bookmarks.push({ id, name, view: state });
  }
  return bookmarks;
}

/** A button that opens the saved views: a name field with Save, and per view a Go and a Remove button. */
export class BookmarksControl implements UiControl {
  readonly id: string;
  readonly position: ControlPosition;
  readonly #storageKey: string | undefined;
  readonly #prefix = `vg-ui-bookmarks-${++instances}`;
  #bookmarks: Bookmark[];
  #counter = 0;
  #context: ControlContext | undefined;
  #button: HTMLButtonElement | undefined;
  #panel: HTMLElement | undefined;
  #name: HTMLInputElement | undefined;
  #save: HTMLButtonElement | undefined;
  #list: HTMLUListElement | undefined;

  /** @param options - Placement, storage and initial bookmarks; every field is optional. */
  constructor(options: BookmarksControlOptions = {}) {
    this.id = options.id ?? 'bookmarks';
    this.position = options.position ?? 'top-left';
    this.#storageKey = options.storageKey;
    this.#bookmarks = this.#load() ?? [...(options.bookmarks ?? [])];
    this.#counter = this.#bookmarks.length;
  }

  /** Builds the control's element (UiControl). */
  mount(context: ControlContext): HTMLElement {
    this.#context = context;
    const frame = controlFrame('bookmarks');
    const button = iconButton('bookmarks', icon(ICONS.bookmark));
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', `${this.#prefix}-panel`);
    button.addEventListener('click', () => this.setOpen(!this.open));
    const panel = document.createElement('div');
    panel.id = `${this.#prefix}-panel`;
    panel.className = 'vg-ui__panel vg-ui__bookmarks-panel';
    panel.hidden = true;
    const form = document.createElement('form');
    form.className = 'vg-ui__bookmarks-form';
    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'vg-ui__text-input';
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'vg-ui__button vg-ui__button--text vg-ui__button--bookmark-add';
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.add(name.value.trim() || undefined);
      name.value = '';
    });
    form.append(name, save);
    const list = document.createElement('ul');
    list.className = 'vg-ui__bookmarks-list';
    panel.append(form, list);
    panel.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      this.setOpen(false);
      button.focus();
    });
    frame.append(button, panel);
    this.#button = button;
    this.#panel = panel;
    this.#name = name;
    this.#save = save;
    this.#list = list;
    return frame;
  }

  /** Whether the panel is open. */
  get open(): boolean {
    return this.#panel?.hidden === false;
  }

  /** Opens or closes the panel. */
  setOpen(open: boolean): void {
    if (this.#panel === undefined || this.#button === undefined) return;
    this.#panel.hidden = !open;
    this.#button.setAttribute('aria-expanded', String(open));
    this.localize();
  }

  /** The bookmarks in the order they were saved. */
  list(): readonly Bookmark[] {
    return this.#bookmarks;
  }

  /** Saves the current view under `name` (by default "View n"); returns the bookmark, or undefined without a view. */
  add(name?: string): Bookmark | undefined {
    const context = this.#context;
    const view = context === undefined ? undefined : viewStateOf(context.globe.camera);
    if (context === undefined || view === undefined) return undefined;
    this.#counter += 1;
    const bookmark: Bookmark = {
      id: `${Date.now().toString(36)}-${this.#counter}`,
      name: name ?? context.i18n.t('bookmarks.defaultName', { number: String(this.#counter) }),
      view,
    };
    this.#bookmarks = [...this.#bookmarks, bookmark];
    this.#changed();
    return bookmark;
  }

  /** Flies to a bookmark; false when there is none with this id. */
  go(id: string): boolean {
    const bookmark = this.#bookmarks.find((candidate) => candidate.id === id);
    const globe = this.#context?.globe;
    if (bookmark === undefined || globe === undefined) return false;
    void applyViewState(globe, bookmark.view, { movement: 'fly' });
    return true;
  }

  /** Removes a bookmark; false when there is none with this id. */
  remove(id: string): boolean {
    const before = this.#bookmarks.length;
    this.#bookmarks = this.#bookmarks.filter((bookmark) => bookmark.id !== id);
    if (this.#bookmarks.length === before) return false;
    this.#changed();
    return true;
  }

  /** The bookmarks as JSON text, which {@link importJson} reads back identically. */
  exportJson(): string {
    return JSON.stringify(
      this.#bookmarks.map(({ id, name, view }) => ({ id, name, view: JSON.parse(viewStateToJson(view)) as unknown })),
    );
  }

  /** Replaces the bookmarks with those of JSON text from {@link exportJson}; false (and nothing changed) when invalid. */
  importJson(json: string): boolean {
    const bookmarks = parseBookmarks(json);
    if (bookmarks === undefined) return false;
    this.#bookmarks = bookmarks;
    this.#counter = Math.max(this.#counter, bookmarks.length);
    this.#changed();
    return true;
  }

  /** Updates texts and accessible names to the current language (UiControl). */
  localize(): void {
    const i18n = this.#context?.i18n;
    if (i18n === undefined || this.#button === undefined) return;
    label(this.#button, i18n.t(this.open ? 'bookmarks.close' : 'bookmarks.open'));
    this.#panel?.setAttribute('aria-label', i18n.t('bookmarks.label'));
    if (this.#name !== undefined) {
      this.#name.setAttribute('aria-label', i18n.t('bookmarks.name'));
      this.#name.placeholder = i18n.t('bookmarks.name');
    }
    if (this.#save !== undefined) this.#save.textContent = i18n.t('bookmarks.add');
    this.#render();
  }

  /** Nothing to release (UiControl). */
  destroy(): void {
    this.#context = undefined;
  }

  #changed(): void {
    if (this.#storageKey !== undefined)
      try {
        localStorage.setItem(this.#storageKey, this.exportJson());
      } catch {
        // Storage refused (private mode, quota): the bookmarks stay in memory.
      }
    this.#render();
  }

  #load(): Bookmark[] | undefined {
    if (this.#storageKey === undefined) return undefined;
    try {
      const json = localStorage.getItem(this.#storageKey);
      return json === null ? undefined : parseBookmarks(json);
    } catch {
      return undefined;
    }
  }

  #render(): void {
    const list = this.#list;
    const i18n = this.#context?.i18n;
    if (list === undefined || i18n === undefined) return;
    if (this.#bookmarks.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'vg-ui__bookmarks-empty';
      empty.textContent = i18n.t('bookmarks.empty');
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(
      ...this.#bookmarks.map((bookmark) => {
        const item = document.createElement('li');
        item.className = 'vg-ui__bookmark';
        const go = document.createElement('button');
        go.type = 'button';
        go.className = 'vg-ui__button vg-ui__button--text vg-ui__button--bookmark-go';
        go.textContent = bookmark.name;
        go.setAttribute('aria-label', i18n.t('bookmarks.go', { name: bookmark.name }));
        go.addEventListener('click', () => this.go(bookmark.id));
        const remove = iconButton('bookmark-remove', icon(ICONS.trash));
        label(remove, i18n.t('bookmarks.remove', { name: bookmark.name }));
        remove.addEventListener('click', () => {
          this.remove(bookmark.id);
          this.#name?.focus();
        });
        item.append(go, remove);
        return item;
      }),
    );
  }
}
