// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { CameraMovement, CameraState, GeoPosition, NavigationApi, ScreenPoint, ViewInit } from '@vibeglobe/core';
import { createControls, type NavigationControls } from './create-controls.js';
import type { ControlsOptions } from './options.js';

/** A recorded DOM listener. */
type Handler = (event: object) => void;

/** A stand-in for a DOM event target that records its listeners. */
export function fakeTarget(): {
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
  /** The engine clock, milliseconds (advanced by the harness's frames). */
  timeMs = 0;
  /** Camera changes made while coasting, and whether the controls are coasting now. */
  coastingChanges = 0;
  coasting = false;
  /** API movements stopped by a press. */
  movementInterruptions = 0;
  /** The views a smoothed zoom said it heads for (F672), undefined on arrival. */
  readonly aheads: (ViewInit | undefined)[] = [];

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

  readonly navigation: NavigationApi = this.createNavigation();

  protected createNavigation(): NavigationApi {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the getters below read this camera
    const camera = this;
    return {
      grab: (point) => {
        const world = this.worldAt(point);
        return { longitudeDeg: world.x, latitudeDeg: world.y };
      },
      dragTo: (anchor: GeoPosition, point) => {
        this.drags++;
        if (this.coasting) this.coastingChanges++;
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
      preloadView: (view) => void this.aheads.push(view),
      requestUpdate: () => void this.requests++,
      interruptMovement: () => void this.movementInterruptions++,
      // The engine's tilt policy array (F625): the tests write `[3]` as the engine would.
      tiltPolicy: new Float64Array(6),
      orbit: (deltaHeadingDeg, deltaTiltDeg) => {
        this.jumps++;
        this.headingDeg = (((this.headingDeg + deltaHeadingDeg) % 360) + 360) % 360;
        this.tiltDeg = Math.min(90, Math.max(0, this.tiltDeg + deltaTiltDeg));
      },
      get timeMs() {
        return camera.timeMs;
      },
      timeInto: (out: Float64Array) => {
        out[0] = camera.timeMs;
      },
      get coasting() {
        return camera.coasting;
      },
      set coasting(value: boolean) {
        camera.coasting = value;
      },
      get headingDeg() {
        return camera.headingDeg;
      },
      get tiltDeg() {
        return camera.tiltDeg;
      },
    };
  }
}

/** A 3-vector. */
type Vec3 = [number, number, number];

/**
 * A zoomed-out globe behind {@link NavigationApi} (KB-202): a sphere of `radiusPx` seen orthographically at the screen
 * center, surrounded by empty space. `grab` finds nothing off its disc and `dragTo` leaves the camera where it was when
 * the pixel is off the disc or the point is behind, as the engine does; otherwise it turns the globe by the shortest
 * rotation that brings the point under the pixel. Positions are degrees on the unit sphere.
 */
export class OrthoGlobe extends FlatCamera {
  /** Columns: the view-frame axes (x right, y down, z toward the eye) in globe coordinates; rows map view to globe. */
  private m: number[] | undefined;

  constructor(
    widthPx: number,
    heightPx: number,
    readonly radiusPx: number,
  ) {
    super(widthPx, heightPx);
  }

  /** The globe-to-view rotation, row-major (identity at first: the globe point (0, 0, 1) faces the eye). */
  private rotation(): number[] {
    return (this.m ??= [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  }

  /** The view-frame unit vector under a pixel, or undefined off the disc. */
  viewVector(point: ScreenPoint): Vec3 | undefined {
    const x = (point.xPx - this.widthPx / 2) / this.radiusPx;
    const y = (point.yPx - this.heightPx / 2) / this.radiusPx;
    const r2 = x * x + y * y;
    return r2 <= 1 ? [x, y, Math.sqrt(1 - r2)] : undefined;
  }

  /** The globe vector the screen center shows: it moves as the globe turns. */
  centerVector(): Vec3 {
    const m = this.rotation();
    // The view z axis in globe coordinates: the transpose's third column, the rotation's third row.
    return [m[6] ?? 0, m[7] ?? 0, m[8] ?? 0];
  }

  private toGlobe(v: Vec3): Vec3 {
    const m = this.rotation();
    // globe = Rᵀ · view, R globe-to-view.
    return [
      (m[0] ?? 0) * v[0] + (m[3] ?? 0) * v[1] + (m[6] ?? 0) * v[2],
      (m[1] ?? 0) * v[0] + (m[4] ?? 0) * v[1] + (m[7] ?? 0) * v[2],
      (m[2] ?? 0) * v[0] + (m[5] ?? 0) * v[1] + (m[8] ?? 0) * v[2],
    ];
  }

  private toView(g: Vec3): Vec3 {
    const m = this.rotation();
    return [
      (m[0] ?? 0) * g[0] + (m[1] ?? 0) * g[1] + (m[2] ?? 0) * g[2],
      (m[3] ?? 0) * g[0] + (m[4] ?? 0) * g[1] + (m[5] ?? 0) * g[2],
      (m[6] ?? 0) * g[0] + (m[7] ?? 0) * g[1] + (m[8] ?? 0) * g[2],
    ];
  }

  protected override createNavigation(): NavigationApi {
    const flat = super.createNavigation();
    const RAD = Math.PI / 180;
    const navigation: NavigationApi = Object.create(flat) as NavigationApi;
    navigation.grab = (point) => {
      const v = this.viewVector(point);
      if (!v) return undefined;
      const g = this.toGlobe(v);
      return {
        longitudeDeg: Math.atan2(g[0], g[2]) / RAD,
        latitudeDeg: Math.asin(Math.max(-1, Math.min(1, -g[1]))) / RAD,
      };
    };
    navigation.dragTo = (anchor, point) => {
      this.drags++;
      if (this.coasting) this.coastingChanges++;
      const b = this.viewVector(point);
      const lon = anchor.longitudeDeg * RAD;
      const lat = anchor.latitudeDeg * RAD;
      const view = this.toView([Math.cos(lat) * Math.sin(lon), -Math.sin(lat), Math.cos(lat) * Math.cos(lon)]);
      // Unit length, or rounding would shrink the rotation a little at every step.
      const length = Math.hypot(...view);
      const a: Vec3 = [view[0] / length, view[1] / length, view[2] / length];
      // Off the disc, or a point behind the globe: no solution, the camera stays.
      if (!b || a[2] < 0) return;
      // The shortest rotation from a to b (Rodrigues), applied after the current one.
      const axis: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const sin = Math.hypot(...axis);
      const cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      if (sin < 1e-15) return;
      const [kx, ky, kz] = [axis[0] / sin, axis[1] / sin, axis[2] / sin];
      const t = 1 - cos;
      const r = [
        cos + kx * kx * t,
        kx * ky * t - kz * sin,
        kx * kz * t + ky * sin,
        ky * kx * t + kz * sin,
        cos + ky * ky * t,
        ky * kz * t - kx * sin,
        kz * kx * t - ky * sin,
        kz * ky * t + kx * sin,
        cos + kz * kz * t,
      ];
      const m = this.rotation();
      const next: number[] = [];
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++) {
          let sum = 0;
          for (let k = 0; k < 3; k++) sum += (r[i * 3 + k] ?? 0) * (m[k * 3 + j] ?? 0);
          next.push(sum);
        }
      this.m = next;
    };
    return navigation;
  }
}

/** A fake document: overlays the zoom box appends land in `overlays`. */
function fakeDocument(overlays: FakeOverlay[], reducedMotion: boolean, hostNow: () => number) {
  return {
    ...fakeTarget(),
    defaultView: {
      ...fakeTarget(),
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
    get timeMs(): number {
      return camera.timeMs;
    },
    set timeMs(value: number) {
      camera.timeMs = value;
    },
    get camera(): CameraState {
      const { centerX, centerY, zoom, headingDeg, tiltDeg } = camera;
      return { longitudeDeg: centerX, latitudeDeg: centerY, zoom, headingDeg, tiltDeg } as CameraState;
    },
    viewMode: 'auto' as 'auto' | '2d' | 'manual',
    handlers: new Map<string, (payload: never) => void>(),
    on(event: string, handler: (payload: never) => void): () => void {
      this.handlers.set(event, handler);
      return () => this.handlers.delete(event);
    },
    /** Announces a globe event to the controls, as the engine does. */
    emit(event: string, payload: unknown): void {
      this.handlers.get(event)?.(payload as never);
    },
    setViewMode(mode: '2d' | '3d' | 'auto'): void {
      this.viewMode = mode === '3d' ? 'manual' : mode;
    },
    jumpTo(view: ViewInit): CameraMovement {
      camera.jumps++;
      if (view.headingDeg !== undefined) camera.headingDeg = view.headingDeg;
      if (view.tiltDeg !== undefined) camera.tiltDeg = view.tiltDeg;
      // A jump completes at once (ADR 0036).
      return Object.assign(Promise.resolve('completed' as const), { cancel: () => undefined });
    },
  };
}

/** The flat map, or with `globeRadiusPx` a zoomed-out globe of that radius surrounded by space (KB-202). */
function harnessCamera(width: number, height: number, globeRadiusPx: number | undefined): FlatCamera {
  return globeRadiusPx === undefined ? new FlatCamera(width, height) : new OrthoGlobe(width, height, globeRadiusPx);
}

const NO_MODIFIERS = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false };

/** How {@link controlsHarness} sets up; `globeRadiusPx` gives an {@link OrthoGlobe} instead of the flat map. */
interface HarnessSetup {
  connect?: boolean;
  reducedMotion?: boolean;
  hostNow?: () => number;
  globeRadiusPx?: number;
}

/** Controls attached to a fake 800 × 600 canvas at (10, 20), a {@link FlatCamera} and an engine clock. */
export function controlsHarness(options?: ControlsOptions, setup: HarnessSetup = {}) {
  const { connect = true, reducedMotion = false, hostNow = (): number => 0 } = setup;
  const width = 800;
  const height = 600;
  const camera = harnessCamera(width, height, setup.globeRadiusPx);
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
    /** Fires an event at the window (`blur` when the page loses focus). */
    fireWindow: (type: string) => fire(doc.defaultView, type, {}),
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
