import type { CameraState, GeoPosition, NavigationApi, ScreenPoint, ViewInit } from '@vibeglobe/core';
import { createControls, type NavigationControls } from './create-controls.js';
import type { ControlsOptions } from './options.js';

/** A recorded DOM listener. */
type Handler = (event: object) => void;

/** A stand-in for a DOM event target that records its listeners. */
function fakeTarget(): {
  listeners: Map<string, Handler>;
  addEventListener: (t: string, l: Handler) => void;
  removeEventListener: (t: string) => void;
} {
  const listeners = new Map<string, Handler>();
  return {
    listeners,
    addEventListener: (type, listener) => void listeners.set(type, listener),
    removeEventListener: (type) => void listeners.delete(type),
  };
}

/** One overlay element the zoom box appended to the fake body. */
export interface FakeOverlay {
  dataset: Record<string, string>;
  style: Record<string, string>;
  removed: boolean;
  remove(): void;
}

/**
 * A flat test camera behind {@link NavigationApi}: world units are pixels at zoom 0, the screen center shows `center`,
 * and zooming scales by 2^zoom. Enough to check that a grabbed point stays under the pointer and that zoom adds up.
 */
export class FlatCamera {
  centerX = 0;
  centerY = 0;
  zoom = 0;
  headingDeg = 0;
  tiltDeg = 0;
  drags = 0;
  zooms = 0;
  jumps = 0;
  requests = 0;

  constructor(
    readonly widthPx: number,
    readonly heightPx: number,
  ) {}

  /** The world point a pixel shows. */
  worldAt(point: ScreenPoint): { x: number; y: number } {
    const scale = 2 ** this.zoom;
    return {
      x: this.centerX + (point.xPx - this.widthPx / 2) / scale,
      y: this.centerY + (point.yPx - this.heightPx / 2) / scale,
    };
  }

  /** The pixel a world point shows at. */
  pixelOf(world: { x: number; y: number }): ScreenPoint {
    const scale = 2 ** this.zoom;
    return {
      xPx: (world.x - this.centerX) * scale + this.widthPx / 2,
      yPx: (world.y - this.centerY) * scale + this.heightPx / 2,
    };
  }

  readonly navigation: NavigationApi = {
    grab: (point) => {
      const world = this.worldAt(point);
      return { longitudeDeg: world.x, latitudeDeg: world.y };
    },
    dragTo: (anchor: GeoPosition, point) => {
      this.drags++;
      const scale = 2 ** this.zoom;
      this.centerX = anchor.longitudeDeg - (point.xPx - this.widthPx / 2) / scale;
      this.centerY = anchor.latitudeDeg - (point.yPx - this.heightPx / 2) / scale;
    },
    zoomAt: (point, deltaZoom) => {
      this.zooms++;
      const world = this.worldAt(point);
      this.zoom += deltaZoom;
      const scale = 2 ** this.zoom;
      this.centerX = world.x - (point.xPx - this.widthPx / 2) / scale;
      this.centerY = world.y - (point.yPx - this.heightPx / 2) / scale;
    },
    requestUpdate: () => void this.requests++,
  };
}

/** A fake document: overlays the zoom box appends land in `overlays`. */
function fakeDocument(overlays: FakeOverlay[], reducedMotion: boolean, hostNow: () => number) {
  return {
    ...fakeTarget(),
    defaultView: {
      performance: { now: hostNow },
      matchMedia: () => ({ matches: reducedMotion }),
    },
    createElement: (): FakeOverlay => {
      const overlay: FakeOverlay = {
        dataset: {},
        style: {},
        removed: false,
        remove: () => void (overlay.removed = true),
      };
      return overlay;
    },
    body: { append: (overlay: FakeOverlay) => void overlays.push(overlay) },
  };
}

/** A fake canvas of `width` × `height` CSS pixels at (10, 20). */
function fakeElement(doc: ReturnType<typeof fakeDocument>, width: number, height: number) {
  const element = {
    ...fakeTarget(),
    ownerDocument: doc,
    style: { touchAction: 'auto', outline: '' },
    clientWidth: width,
    clientHeight: height,
    focusVisible: true,
    tabIndex: -1,
    hasAttribute: () => false,
    removeAttribute: () => undefined,
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
    setPointerCapture: () => undefined,
    hasPointerCapture: () => true,
    releasePointerCapture: () => undefined,
    focus: () => undefined,
    matches: () => element.focusVisible,
  };
  return element;
}

/** Pointer event fields a test may set. */
export interface PointerInit {
  readonly x: number;
  readonly y: number;
  readonly t: number;
  readonly id?: number;
  readonly pointerType?: 'mouse' | 'touch' | 'pen';
  readonly button?: number;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
}

/** The parts of a globe the controls read once connected, on a {@link FlatCamera}. */
function fakeGlobe(camera: FlatCamera) {
  return {
    timeMs: 0,
    get camera(): CameraState {
      return { headingDeg: camera.headingDeg, tiltDeg: camera.tiltDeg } as CameraState;
    },
    jumpTo(view: ViewInit) {
      camera.jumps++;
      if (view.headingDeg !== undefined) camera.headingDeg = view.headingDeg;
      if (view.tiltDeg !== undefined) camera.tiltDeg = view.tiltDeg;
    },
  };
}

const NO_MODIFIERS = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false };

/** Controls attached to a fake 800 × 600 canvas at (10, 20), a {@link FlatCamera} and an engine clock. */
export function controlsHarness(
  options?: ControlsOptions,
  { connect = true, reducedMotion = false, hostNow = (): number => 0 } = {},
) {
  const width = 800;
  const height = 600;
  const camera = new FlatCamera(width, height);
  const overlays: FakeOverlay[] = [];
  const doc = fakeDocument(overlays, reducedMotion, hostNow);
  const element = fakeElement(doc, width, height);
  const globe = fakeGlobe(camera);
  const controls: NavigationControls = createControls(options);
  const instance = controls(element, camera.navigation);
  if (connect) controls.connect(globe);
  // The engine's first frame.
  instance.update?.();
  let prevented = 0;
  const fire = (target: { listeners: Map<string, Handler> }, type: string, event: object): void => {
    target.listeners.get(type)?.({ type, preventDefault: () => void prevented++, ...event });
  };
  const pointer = (type: string, init: PointerInit): void =>
    fire(element, type, {
      pointerId: init.id ?? 1,
      pointerType: init.pointerType ?? 'mouse',
      button: init.button ?? 0,
      ctrlKey: init.ctrlKey ?? false,
      shiftKey: init.shiftKey ?? false,
      clientX: init.x + 10,
      clientY: init.y + 20,
      timeStamp: init.t,
    });
  const key = (type: 'keydown' | 'keyup', name: string, extra: object = {}): void => {
    const event = { key: name, ...NO_MODIFIERS, ...extra };
    fire(element, type, event);
    fire(doc, type, event);
  };
  return {
    camera,
    controls,
    instance,
    element,
    doc,
    globe,
    overlays,
    prevented: () => prevented,
    fire: (type: string, event: object) => fire(element, type, event),
    pointer,
    key,
    /** Advances the engine clock by `dtMs` and runs one frame's update. */
    frame(dtMs = 1000 / 60): void {
      globe.timeMs += dtMs;
      instance.update?.();
    },
    /** Runs frames of `dtMs` until `untilMs` of engine time. */
    run(untilMs: number, dtMs = 1000 / 60): void {
      while (globe.timeMs + dtMs <= untilMs + 1e-9) this.frame(dtMs);
    },
  };
}
