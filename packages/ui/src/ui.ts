/**
 * The UI layer over a globe: places controls in the map's corners, applies the theme and the language, and lets the
 * application add, remove, replace and extend controls one by one (F418). The engine runs without any of it.
 */
import type { Globe } from '@vibeglobe/core';
import type { GlobeLayers } from '@vibeglobe/layers';

/** The `@vibeglobe/layers` module, as a dynamic import resolves it. */
type LayersModule = typeof import('@vibeglobe/layers');
import { Translator } from './i18n/translator.js';
import { installStyles, styleRootOf, uninstallStyles } from './theme/install.js';
import type { ThemeName } from './theme/styles.js';

/** Corners of the map that hold controls. */
export type ControlPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** What a control receives when it is added: the engine through its public API, the language and system settings. */
export interface ControlContext {
  readonly globe: Globe;
  /** The element the map fills. */
  readonly container: HTMLElement;
  readonly i18n: Translator;
  /** Whether the system currently asks for reduced motion. */
  reducedMotion(): boolean;
  /**
   * The data layers the controls draw with (geolocation, drawing and measurement): the application's, passed in
   * {@link UiOptions.layers}, else one stack the UI creates on first use (`@vibeglobe/layers` is loaded only then).
   * Resolves after `globe.ready`. `load` imports `@vibeglobe/layers` (`() => import('@vibeglobe/layers')`): the
   * control that draws loads the package, so a UI without such controls never bundles it.
   */
  layers(load: () => Promise<LayersModule>): Promise<GlobeLayers>;
}

/**
 * A control: built-in ones implement this interface, and an application's own controls do too. A control may also be
 * extended by subclassing a built-in one.
 */
export interface UiControl {
  /** Unique name within a UI, used to remove or replace the control. */
  readonly id: string;
  /** The corner that holds the control. */
  readonly position: ControlPosition;
  /** Builds the control's element, which the UI places; called once, when the control is added. */
  mount(context: ControlContext): HTMLElement;
  /** Updates the control's texts after a change of language or strings. */
  localize?(): void;
  /** Releases listeners and timers; the UI removes the element. */
  destroy(): void;
}

/** Options of {@link createUi}. */
export interface UiOptions {
  /** Initial theme (default 'light'). */
  readonly theme?: ThemeName;
  /** Initial language (default 'en'). */
  readonly language?: string;
  /**
   * The application's data layers on this globe (`createGlobeLayers`), which the drawing, measurement and geolocation
   * controls add their layers to; without it the UI creates its own on first use. One stack per globe keeps the
   * picking ids apart.
   */
  readonly layers?: GlobeLayers;
}

/** A UI layer over one globe. */
export interface Ui {
  /** The layer element, the `.vg-ui` element where theme variables apply. */
  readonly element: HTMLElement;
  /** The UI's translations: languages, overrides and number formats. */
  readonly i18n: Translator;
  readonly theme: ThemeName;
  /** Adds a control at the end of its corner; throws when its id is taken. */
  add(control: UiControl): void;
  /** Removes and destroys the control with this id; returns false when there is none. */
  remove(id: string): boolean;
  /** Puts `control` in the place of the control with the same id, which is destroyed. */
  replace(control: UiControl): void;
  /** The control with this id. */
  get(id: string): UiControl | undefined;
  /** The controls in the order they were added. */
  controls(): UiControl[];
  /** Switches between the built-in light and dark themes at runtime. */
  setTheme(theme: ThemeName): void;
  /** Switches the language at runtime (a shortcut for `i18n.setLanguage`). */
  setLanguage(code: string): void;
  /** Removes every control and the layer. */
  destroy(): void;
}

const POSITIONS: readonly ControlPosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

/** The layer element and its corners. */
function createLayer(container: HTMLElement): { element: HTMLElement; corners: Map<ControlPosition, HTMLElement> } {
  const element = document.createElement('div');
  element.className = 'vg-ui';
  element.setAttribute('role', 'region');
  const corners = new Map<ControlPosition, HTMLElement>();
  for (const position of POSITIONS) {
    const corner = document.createElement('div');
    corner.className = `vg-ui__corner vg-ui__corner--${position}`;
    corners.set(position, corner);
    element.append(corner);
  }
  container.append(element);
  return { element, corners };
}

/**
 * Keeps the bottom corners above the engine's own attribution element (`.vg-credits`, F255), which the engine pins to
 * the container's bottom right: its height becomes `--vg-credits-height` on the layer, so no control covers it.
 */
function keepClearOfCredits(container: HTMLElement, layer: HTMLElement): () => void {
  let observed: Element | undefined;
  const measure = (): void => {
    const credits = container.querySelector(':scope > .vg-credits') ?? undefined;
    if (credits !== observed) {
      if (observed) resize.unobserve(observed);
      if (credits) resize.observe(credits);
      observed = credits;
    }
    const height = credits?.getBoundingClientRect().height ?? 0;
    layer.style.setProperty('--vg-credits-height', `${height}px`);
  };
  const resize = new ResizeObserver(measure);
  const children = new MutationObserver(measure);
  children.observe(container, { childList: true });
  measure();
  return () => {
    resize.disconnect();
    children.disconnect();
  };
}

class UiLayer implements Ui {
  readonly element: HTMLElement;
  readonly i18n = new Translator();
  readonly #corners: Map<ControlPosition, HTMLElement>;
  readonly #context: ControlContext;
  readonly #mounted = new Map<string, { control: UiControl; element: HTMLElement }>();
  readonly #stopLanguage: () => void;
  readonly #stopCredits: () => void;
  #theme: ThemeName = 'light';
  #destroyed = false;

  #layers: Promise<GlobeLayers> | undefined;
  #ownLayers: GlobeLayers | undefined;

  constructor(globe: Globe, container: HTMLElement, layers: GlobeLayers | undefined) {
    installStyles(styleRootOf(container));
    ({ element: this.element, corners: this.#corners } = createLayer(container));
    const motionQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
    this.#layers = layers === undefined ? undefined : Promise.resolve(layers);
    this.#context = {
      globe,
      container,
      i18n: this.i18n,
      reducedMotion: () => motionQuery?.matches === true,
      layers: (load) =>
        (this.#layers ??= globe.ready.then(async () => {
          const { createGlobeLayers } = await load();
          if (this.#destroyed) throw new Error('The UI was destroyed');
          this.#ownLayers = createGlobeLayers(globe, { element: container });
          return this.#ownLayers;
        })),
    };
    this.#stopLanguage = this.i18n.onChange(() => this.localize());
    this.#stopCredits = keepClearOfCredits(container, this.element);
  }

  get theme(): ThemeName {
    return this.#theme;
  }

  add(control: UiControl): void {
    if (this.#destroyed) throw new Error('The UI was destroyed');
    if (this.#mounted.has(control.id)) throw new Error(`A control with id "${control.id}" is already added`);
    const built = this.#build(control);
    this.#corners.get(control.position)?.append(built);
    this.#mounted.set(control.id, { control, element: built });
    control.localize?.();
  }

  remove(id: string): boolean {
    const entry = this.#mounted.get(id);
    if (entry === undefined) return false;
    this.#mounted.delete(id);
    entry.control.destroy();
    entry.element.remove();
    return true;
  }

  replace(control: UiControl): void {
    const old = this.#mounted.get(control.id);
    if (old === undefined) {
      this.add(control);
      return;
    }
    const built = this.#build(control);
    if (old.control.position === control.position) old.element.replaceWith(built);
    else this.#corners.get(control.position)?.append(built);
    old.control.destroy();
    old.element.remove();
    this.#mounted.set(control.id, { control, element: built });
    control.localize?.();
  }

  get(id: string): UiControl | undefined {
    return this.#mounted.get(id)?.control;
  }

  controls(): UiControl[] {
    return [...this.#mounted.values()].map(({ control }) => control);
  }

  setTheme(theme: ThemeName): void {
    if (theme !== 'light' && theme !== 'dark') throw new RangeError(`Unknown theme "${String(theme)}"`);
    this.#theme = theme;
    this.element.dataset['theme'] = theme;
  }

  setLanguage(code: string): void {
    this.i18n.setLanguage(code);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#stopLanguage();
    this.#stopCredits();
    for (const id of [...this.#mounted.keys()]) this.remove(id);
    this.element.remove();
    this.#ownLayers?.detach();
    this.#ownLayers?.stack.clear();
    uninstallStyles(styleRootOf(this.#context.container));
  }

  /** Applies the current language to the layer and every control. */
  localize(): void {
    this.element.setAttribute('aria-label', this.i18n.t('controls.label'));
    this.element.lang = this.i18n.language;
    for (const { control } of this.#mounted.values()) control.localize?.();
  }

  #build(control: UiControl): HTMLElement {
    const built = control.mount(this.#context);
    built.dataset['control'] = control.id;
    return built;
  }
}

/**
 * Adds a UI layer to the map container of `globe`. The container must be positioned (the globe's own container is).
 *
 * @param globe - The engine instance, used through its public API only.
 * @param container - The element the map fills.
 * @param options - Initial theme and language.
 */
export function createUi(globe: Globe, container: HTMLElement, options: UiOptions = {}): Ui {
  const ui = new UiLayer(globe, container, options.layers);
  ui.setTheme(options.theme ?? 'light');
  if (options.language !== undefined) ui.i18n.setLanguage(options.language);
  ui.localize();
  return ui;
}
