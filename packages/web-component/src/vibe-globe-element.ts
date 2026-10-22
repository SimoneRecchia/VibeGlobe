import { createControls } from '@vibeglobe/controls';
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
import { watchClicks, type GlobeClickEvent } from './click.js';

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
  /** Attribute `center="<longitude>, <latitude>"`, degrees. */
  center: CenterDeg | undefined;
  /** Attribute `zoom`. */
  zoom: number | undefined;
  /** Attribute `heading-deg`. */
  headingDeg: number | undefined;
  /** Attribute `tilt-deg`. */
  tiltDeg: number | undefined;
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
const VIEW_ATTRIBUTES = ['center', 'zoom', 'heading-deg', 'tilt-deg'] as const;

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

/** The engine options from the element's attributes and its `imagery` property. */
function readOptions(element: HTMLElement, container: HTMLElement, sources: readonly ImagerySource[]): GlobeOptions {
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
    ...(element.hasAttribute('no-controls') ? {} : { controls: createControls() }),
    baseImageryUrl: element.getAttribute('base-imagery-url') ?? '',
    view: readView(element),
    ...(imagery.length > 0 ? { imagery, workers: createWorkers() } : {}),
  };
}

/** Starts an engine and dispatches its events on the element; returns the engine and the function that stops both. */
function startEngine(
  element: HTMLElement,
  container: HTMLElement,
  options: GlobeOptions,
): { globe: Globe; stop: () => void } {
  const emit = <E extends keyof VibeGlobeEventDetail>(type: E, detail: VibeGlobeEventDetail[E]): void =>
    void element.dispatchEvent(new CustomEvent(type, { detail }));
  const globe = createGlobe(options);
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
  return {
    globe,
    stop: () => {
      for (const stop of stops) stop();
      globe.destroy();
    },
  };
}

/** The element class, made only when it is registered, so importing the package touches no DOM global. */
function makeElementClass(): new () => VibeGlobeElement {
  const element = class extends HTMLElement {
    static readonly observedAttributes = VIEW_ATTRIBUTES;
    imagery: readonly ImagerySource[] = [];
    #engine: { globe: Globe; stop: () => void } | undefined;
    readonly #container: HTMLDivElement;

    constructor() {
      super();
      const shadow = this.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = STYLE;
      this.#container = document.createElement('div');
      this.#container.className = 'engine';
      this.#container.setAttribute('part', 'engine');
      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      overlay.append(document.createElement('slot'));
      shadow.append(style, this.#container, overlay);
    }

    get globe(): Globe | undefined {
      return this.#engine?.globe;
    }

    connectedCallback(): void {
      // Moving the element to another parent disconnects and reconnects it: the engine keeps running.
      this.#engine ??= startEngine(this, this.#container, readOptions(this, this.#container, this.imagery));
    }

    disconnectedCallback(): void {
      // A move reconnects in the same task; only an element still out of the document after it stops its engine.
      queueMicrotask(() => {
        if (this.isConnected) return;
        this.#engine?.stop();
        this.#engine = undefined;
      });
    }

    attributeChangedCallback(): void {
      const globe = this.#engine?.globe;
      if (!globe) return;
      const changed = changedView(globe.camera, readView(this));
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
 * `heading-deg` and `tilt-deg`, which also move a running engine. Events (`CustomEvent`s): `ready`, `load`,
 * `camera-change`, `globe-click` and `error`. The shadow tree exposes the engine's container as part `engine`.
 */
export function defineVibeGlobe(tagName = 'vibe-globe'): new () => VibeGlobeElement {
  const registered = customElements.get(tagName) as (new () => VibeGlobeElement) | undefined;
  if (registered) return registered;
  const element = makeElementClass();
  customElements.define(tagName, element);
  return element;
}
