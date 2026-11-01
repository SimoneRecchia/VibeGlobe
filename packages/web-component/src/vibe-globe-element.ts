// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { createControls, watchClicks, type GlobeClickEvent, type NavigationControls } from '@vibeglobe/controls';
import {
  createGlobe,
  type CameraState,
  type Globe,
  type GlobeError,
  type GlobeEvents,
  type GlobeOptions,
  type ImagerySource,
  type ViewInit,
} from '@vibeglobe/core';
import { createRenderer, type BackendChoice } from '@vibeglobe/renderer';
import { xyzImagery } from '@vibeglobe/sources';
import { createWorkers } from '@vibeglobe/worker';
import { ElementUi, UI_ATTRIBUTES } from './ui-layer.js';
import type { Ui } from '@vibeglobe/ui';

/** The `detail` of each event the element dispatches. */
export interface VibeGlobeEventDetail {
  /** The engine drew its first frame. */
  ready: GlobeEvents['ready'];
  /** The first view finished loading. */
  load: GlobeEvents['idle'];
  'camera-change': CameraState;
  /** A click on the globe, with its position on the ellipsoid. */
  'globe-click': GlobeClickEvent;
  error: GlobeError;
}

/** A position on the globe given to the `center` property. */
export interface CenterDeg {
  readonly longitudeDeg: number;
  readonly latitudeDeg: number;
}

/** The `<vibe-globe>` element: attributes, properties and the engine it runs. */
export interface VibeGlobeElement extends HTMLElement {
  /** The running engine, for the full API; undefined while the element is not in a document. */
  readonly globe: Globe | undefined;
  /** The UI layer inside the shadow tree, created with the `ui` attribute; undefined without it. */
  readonly ui: Promise<Ui> | undefined;
  /** Attribute `center="<longitude>, <latitude>"`, degrees. */
  center: CenterDeg | undefined;
  /** Attribute `zoom`. */
  zoom: number | undefined;
  /** Attribute `heading-deg`. */
  headingDeg: number | undefined;
  /** Attribute `tilt-deg`. */
  tiltDeg: number | undefined;
  /** Attribute `view-mode`: `auto`, `2d` or `3d` (the 2D / 3D / Auto toggle, F163); unset leaves the engine's. */
  viewMode: '2d' | '3d' | 'auto' | undefined;
  /** Imagery sources, bottom first, read when the engine starts; the `imagery-url` attribute adds one XYZ source. */
  imagery: readonly ImagerySource[];
  addEventListener<E extends keyof VibeGlobeEventDetail>(
    type: E,
    listener: (event: CustomEvent<VibeGlobeEventDetail[E]>) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<E extends keyof VibeGlobeEventDetail>(
    type: E,
    listener: (event: CustomEvent<VibeGlobeEventDetail[E]>) => void,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
}

/** Attributes that move the camera of a running engine. */
const VIEW_ATTRIBUTES = ['center', 'zoom', 'heading-deg', 'tilt-deg', 'view-mode'] as const;

/** The `view-mode` attribute's value, or undefined when unset or unknown. */
function parseViewMode(value: string | null): '2d' | '3d' | 'auto' | undefined {
  return value === '2d' || value === '3d' || value === 'auto' ? value : undefined;
}

const STYLE = `
:host { display: block; position: relative; overflow: hidden; min-height: 150px; }
:host([hidden]) { display: none; }
.engine { position: absolute; inset: 0; }
.overlay { position: absolute; inset: 0; pointer-events: none; }
.overlay ::slotted(*) { pointer-events: auto; }
`;

function parseNumber(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function parseCenter(value: string | null): CenterDeg | undefined {
  const parts = value?.split(',').map((part) => parseNumber(part));
  const [longitudeDeg, latitudeDeg] = parts ?? [];
  return parts?.length === 2 && longitudeDeg !== undefined && latitudeDeg !== undefined
    ? { longitudeDeg, latitudeDeg }
    : undefined;
}

function formatNumber(value: number | undefined): string | null {
  return value === undefined ? null : String(value);
}

/** The properties that mirror attributes: their attribute, how to read it and how to write it. */
const REFLECTED: Record<
  string,
  { attribute: string; parse: (text: string | null) => unknown; format: (value: unknown) => string | null }
> = {
  center: {
    attribute: 'center',
    parse: parseCenter,
    format: (value) => {
      const center = value as CenterDeg | undefined;
      return center ? `${center.longitudeDeg}, ${center.latitudeDeg}` : null;
    },
  },
  zoom: { attribute: 'zoom', parse: parseNumber, format: (value) => formatNumber(value as number | undefined) },
  headingDeg: {
    attribute: 'heading-deg',
    parse: parseNumber,
    format: (value) => formatNumber(value as number | undefined),
  },
  tiltDeg: { attribute: 'tilt-deg', parse: parseNumber, format: (value) => formatNumber(value as number | undefined) },
  viewMode: {
    attribute: 'view-mode',
    parse: parseViewMode,
    format: (value) => parseViewMode(String(value ?? '')) ?? null,
  },
};

/** The initial or updated view from the element's attributes. */
function readView(element: HTMLElement): ViewInit {
  const view: Record<string, number> = {};
  const center = parseCenter(element.getAttribute('center'));
  if (center) Object.assign(view, center);
  for (const [field, attribute] of [
    ['zoom', 'zoom'],
    ['headingDeg', 'heading-deg'],
    ['tiltDeg', 'tilt-deg'],
  ] as const) {
    const value = parseNumber(element.getAttribute(attribute));
    if (value !== undefined) view[field] = value;
  }
  return view;
}

/** The view fields that differ from the camera by more than rounding. */
function changedView(camera: CameraState, view: ViewInit): ViewInit {
  const changed: Record<string, number> = {};
  for (const field of ['longitudeDeg', 'latitudeDeg', 'zoom', 'headingDeg', 'tiltDeg'] as const) {
    const wanted = view[field];
    if (wanted !== undefined && Math.abs(wanted - camera[field]) > 1e-9) changed[field] = wanted;
  }
  return changed;
}

/** The view fields each view attribute sets. */
const VIEW_FIELDS: Readonly<Record<string, readonly (keyof ViewInit)[]>> = {
  center: ['longitudeDeg', 'latitudeDeg'],
  zoom: ['zoom'],
  'heading-deg': ['headingDeg'],
  'tilt-deg': ['tiltDeg'],
};

/** Whether the engine's mode is the toggle's choice ('3d' chooses a tilt: the engine reports 'manual'). */
function sameMode(engine: Globe['viewMode'], chosen: '2d' | '3d' | 'auto'): boolean {
  return engine === (chosen === '3d' ? 'manual' : chosen);
}

/** The engine options from the element's attributes and its `imagery` property. */
function readOptions(
  element: HTMLElement,
  container: HTMLElement,
  sources: readonly ImagerySource[],
  controls: NavigationControls | undefined,
): GlobeOptions {
  const backend = element.getAttribute('backend');
  const choice: BackendChoice = backend === 'webgpu' || backend === 'webgl2' ? backend : 'auto';
  const imageryUrl = element.getAttribute('imagery-url');
  const maxLevel = parseNumber(element.getAttribute('imagery-max-level'));
  const fromUrl = imageryUrl
    ? [xyzImagery({ id: 'imagery-url', url: imageryUrl, ...(maxLevel === undefined ? {} : { maxLevel }) })]
    : [];
  const imagery = [...sources, ...fromUrl];
  return {
    container,
    renderer: createRenderer({ backend: choice }),
    ...(controls ? { controls } : {}),
    baseImageryUrl: element.getAttribute('base-imagery-url') ?? '',
    view: readView(element),
    ...(imagery.length > 0 ? { imagery, workers: createWorkers() } : {}),
  };
}

/** Starts an engine and dispatches its events on the element; returns the engine and the function that stops both. */
function startEngine(
  element: HTMLElement,
  container: HTMLElement,
  sources: readonly ImagerySource[],
): { globe: Globe; ui: ElementUi; stop: () => void } {
  const emit = <E extends keyof VibeGlobeEventDetail>(type: E, detail: VibeGlobeEventDetail[E]): void =>
    void element.dispatchEvent(new CustomEvent(type, { detail }));
  const controls = element.hasAttribute('no-controls') ? undefined : createControls();
  const globe = createGlobe(readOptions(element, container, sources, controls));
  // createGlobe connects the controls once its renderer is ready; connecting now lets the tilt policy see API
  // movements that start before that.
  controls?.connect(globe);
  const mode = parseViewMode(element.getAttribute('view-mode'));
  if (mode) globe.setViewMode(mode);
  let ready = false;
  let loaded = false;
  // A failed start is reported through the `error` event; the promise must not reject unhandled.
  globe.ready.catch(() => undefined);
  const stops = [
    globe.on('ready', (payload) => {
      ready = true;
      emit('ready', payload);
    }),
    globe.on('idle', (payload) => {
      if (loaded || !ready) return;
      loaded = true;
      emit('load', payload);
    }),
    globe.on('camera-change', (camera) => emit('camera-change', camera)),
    globe.on('error', (error) => emit('error', error)),
    watchClicks(container, globe, (click) => emit('globe-click', click)),
  ];
  const ui = new ElementUi(element, globe, container);
  ui.sync();
  return {
    globe,
    ui,
    stop: () => {
      for (const stop of stops) stop();
      ui.stop();
      globe.destroy();
    },
  };
}

/** The element class, made only when it is registered, so importing the package touches no DOM global. */
/**
 * Removes the reflected properties a script set on the element before it was defined (own data properties that would
 * hide the accessors) and returns them, to be set again once the element is connected.
 */
function takeEarlyProperties(element: HTMLElement): [property: string, value: unknown][] {
  const early: [string, unknown][] = [];
  for (const property of Object.keys(REFLECTED)) {
    if (!Object.hasOwn(element, property)) continue;
    early.push([property, Reflect.get(element, property)]);
    Reflect.deleteProperty(element, property);
  }
  return early;
}

/** Builds the element's shadow tree and returns the engine's container (part `engine`). */
function buildShadow(host: HTMLElement): HTMLDivElement {
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  const container = document.createElement('div');
  container.className = 'engine';
  container.setAttribute('part', 'engine');
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.append(document.createElement('slot'));
  shadow.append(style, container, overlay);
  return container;
}

function makeElementClass(): new () => VibeGlobeElement {
  const element = class extends HTMLElement {
    static readonly observedAttributes = [...VIEW_ATTRIBUTES, ...UI_ATTRIBUTES];
    // Before the upgrade, a property set by a script is an own data property: keep its value.
    imagery: readonly ImagerySource[] = (Reflect.get(this, 'imagery') as readonly ImagerySource[] | undefined) ?? [];
    #engine: { globe: Globe; ui: ElementUi; stop: () => void } | undefined;
    readonly #container: HTMLDivElement;
    readonly #early = takeEarlyProperties(this);

    constructor() {
      super();
      this.#container = buildShadow(this);
    }

    get globe(): Globe | undefined {
      return this.#engine?.globe;
    }

    get ui(): Promise<Ui> | undefined {
      return this.#engine?.ui.ui;
    }

    connectedCallback(): void {
      for (const [property, value] of this.#early.splice(0)) Reflect.set(this, property, value);
      // Moving the element to another parent disconnects and reconnects it: the engine keeps running.
      this.#engine ??= startEngine(this, this.#container, this.imagery);
    }

    disconnectedCallback(): void {
      // A move reconnects in the same task; only an element still out of the document after it stops its engine.
      queueMicrotask(() => {
        if (this.isConnected) return;
        this.#engine?.stop();
        this.#engine = undefined;
      });
    }

    attributeChangedCallback(name: string, previous: string | null, value: string | null): void {
      const globe = this.#engine?.globe;
      if (!globe || previous === value) return;
      // Only the attribute that changed applies: the rest of the view stays where the user navigated (KB-145).
      if (name === 'view-mode') {
        const mode = parseViewMode(value);
        if (mode && !sameMode(globe.viewMode, mode)) globe.setViewMode(mode);
        return;
      }
      const fields = VIEW_FIELDS[name];
      if (!fields) return this.#engine?.ui.sync();
      const view = readView(this);
      const changed = changedView(globe.camera, Object.fromEntries(fields.map((f) => [f, view[f]])) as ViewInit);
      if (Object.keys(changed).length > 0) globe.jumpTo(changed);
    }
  };
  for (const [property, { attribute, parse, format }] of Object.entries(REFLECTED)) {
    Object.defineProperty(element.prototype, property, {
      get(this: HTMLElement) {
        return parse(this.getAttribute(attribute));
      },
      set(this: HTMLElement, value: unknown) {
        const text = format(value);
        if (text === null) this.removeAttribute(attribute);
        else this.setAttribute(attribute, text);
      },
    });
  }
  return element as unknown as new () => VibeGlobeElement;
}

/**
 * Registers the globe element under a tag name (`vibe-globe` by default) and returns its class; registering a name
 * twice returns the class registered first. Importing the package registers nothing, so it is safe under server-side
 * rendering; call this in the browser before using the element.
 *
 * Attributes: `base-imagery-url` (required), `imagery-url` (an XYZ template) and `imagery-max-level`, `backend`
 * (`auto`, `webgpu` or `webgl2`) and `no-controls`, read when the element is connected; `center`, `zoom`,
 * `heading-deg`, `tilt-deg` and `view-mode` (`auto`, `2d`, `3d`), which also change a running engine; `ui` (`default` or
 * `all`) adds the ui package's controls inside the shadow tree, `theme` (`light`, `dark`) and `lang` switch them. The
 * shadow tree exposes the engine's container as part `engine` and the controls' layer as part `ui`: host pages theme
 * the controls with `vibe-globe::part(ui) { --vg-ui-background: …; }`. Events (`CustomEvent`s): `ready`, `load`,
 * `camera-change`, `globe-click` and `error`.
 */
export function defineVibeGlobe(tagName = 'vibe-globe'): new () => VibeGlobeElement {
  const registered = customElements.get(tagName) as (new () => VibeGlobeElement) | undefined;
  if (registered) return registered;
  const element = makeElementClass();
  customElements.define(tagName, element);
  return element;
}
