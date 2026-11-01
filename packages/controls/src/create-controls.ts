// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { Controls, ControlsFactory, NavigationApi, NavigationMode } from '@vibeglobe/core';
import { HeadingTarget, Inertia, type InertiaTaus, KeyMotion, ZoomTarget } from './animators.js';
import { CameraPort, FRAME_MS, type ConnectedGlobe } from './camera-port.js';
import type { GestureContext } from './gesture-context.js';
import { KeyboardInput } from './keyboard.js';
import { MouseGestures } from './mouse-gestures.js';
import {
  type ControlsOptions,
  resolveControlsOptions,
  type ResolvedControlsOptions,
  type TiltPolicy,
  validNavigationMode,
  validNorthUpLatitude,
} from './options.js';
import { TiltPolicyState } from './tilt-policy.js';
import { TouchGestures } from './touch-gestures.js';
import { WheelInput } from './wheel-input.js';
import { ZoomBox } from './zoom-box.js';
import { domListeners, WheelForwarding } from './dom-listeners.js';

/** The controls factory with commands for buttons and applications. */
export interface NavigationControls extends ControlsFactory {
  /** The settings in use, defaults filled in. */
  readonly options: ResolvedControlsOptions;
  /**
   * Connects the globe the controls drive, after `createGlobe`: the Home and view-mode keys run its commands, a
   * Shift-drag box zooms through its `fitBounds`, and the tilt policy switches it back to the automatic view mode.
   * Without it the other gestures work and those do nothing.
   */
  connect(globe: ConnectedGlobe): void;
  /** Zooms in one level about the screen center, animated; rapid calls accumulate (F174). */
  zoomIn(): void;
  /** Zooms out one level about the screen center, animated; rapid calls accumulate (F174). */
  zoomOut(): void;
  /** Turns the view to north up along the shortest arc, keeping center and tilt. */
  resetNorth(): void;
  /** How a drag moves the camera now (the `navigationMode` option, then {@link NavigationControls.setNavigationMode}). */
  readonly navigationMode: NavigationMode;
  /**
   * Switches how a drag moves the camera, from the next input on: 'free' (trackball) or 'north-up' (north stays up,
   * stops at {@link NavigationControls.northUpMaxLatitudeDeg}). Anything else throws a GlobeError ('invalid-option').
   */
  setNavigationMode(mode: NavigationMode): void;
  /** The 'north-up' latitude limit now, degrees (the `northUpMaxLatitudeDeg` option, then the setter below). */
  readonly northUpMaxLatitudeDeg: number;
  /**
   * Sets the highest latitude a 'north-up' camera looks at, degrees from 1 to 89.9, from the next input on; anything
   * else throws a GlobeError ('invalid-option').
   */
  setNorthUpMaxLatitude(deg: number): void;
  /** The tilt policy in force (F625), or null for none: the `tiltPolicy` option, then {@link NavigationControls.setTiltPolicy}. */
  readonly tiltPolicy: TiltPolicy | null;
  /**
   * Sets the tilt policy (F625): `true` or an object for a policy (missing fields take the defaults, 20,000 m, 2,000 m,
   * 60° and half the lock), `false` or null for none. Beyond `lock2DAboveMeters` the view is flat and cannot tilt; within
   * `autoTiltBelowMeters` the tilt rises by itself to `autoTiltMaxDeg`; both change continuously with the distance. A
   * tilt chosen by hand below the lock stays until changed or until the camera passes the lock. Invalid input throws a
   * GlobeError ('invalid-option').
   */
  setTiltPolicy(policy: boolean | Partial<TiltPolicy> | null): void;
  /** False while the tilt policy keeps the view flat (beyond its lock): a 3D button should be disabled then. */
  readonly tiltAvailable: boolean;
  /**
   * The largest tilt the view allows now, degrees (F642): the engine's empty-sky limit, the camera constraints and the
   * tilt policy's cap, or the tilt terrain clearance holds the camera at while it does, so a tilt slider can show the
   * reachable range. Read it when the camera changes; 90 before the controls are attached.
   */
  readonly maxTiltDeg: number;
  /** Calls `listener` with {@link NavigationControls.tiltAvailable} each time it changes; returns the unsubscribe. */
  onTiltAvailabilityChange(listener: (available: boolean) => void): () => void;
  /**
   * Lets the wheel and the trackpad zoom the map over `element` too (F654): markers, labels or panels laid over the
   * map, which would otherwise take those events. They zoom about the pointer as over the map, and the page neither
   * scrolls nor zooms there. An event the map or the element already handled (its default prevented) is left alone,
   * so `element` may also hold the map. Kept from one attachment to the next; returns the function that stops it.
   */
  forwardWheel(element: EventTarget): () => void;
}

/**
 * Creates mouse, trackpad, touch and keyboard navigation (M6, ADR 0009 §3–6). DOM handlers only record input; once
 * per frame the engine calls `update`, which turns it into camera intents, steps inertia and the smoothed zoom, and
 * keeps frames coming while anything moves. Invalid options throw a GlobeError ('invalid-option').
 */
export function createControls(options?: ControlsOptions): NavigationControls {
  const resolved = resolveControlsOptions(options);
  let globe: ConnectedGlobe | undefined;
  let current: Attached | undefined;
  let mode = resolved.navigationMode;
  let maxLatitudeDeg = resolved.northUpMaxLatitudeDeg;
  let navigationApi: NavigationApi | undefined;
  const wheels = new WheelForwarding();
  const tilt = new TiltPolicyState(resolved.tiltPolicy);
  const factory = (element: unknown, navigation: NavigationApi): Controls => {
    navigationApi = navigation;
    navigation.navigationMode = mode;
    navigation.northUpMaxLatitudeDeg = maxLatitudeDeg;
    tilt.write(navigation);
    const attached = attach(element as HTMLElement, navigation, resolved, globe, wheels);
    current = attached;
    return {
      update() {
        tilt.check(navigationApi, globe);
        attached.update();
      },
      interrupt: attached.interrupt,
      destroy() {
        attached.destroy();
        if (current === attached) current = undefined;
      },
    };
  };
  const controls = Object.assign(factory, {
    options: resolved,
    connect(target: ConnectedGlobe) {
      tilt.follow((globe = target));
      if (current) current.port.globe = target;
    },
    zoomIn: () => current?.keyboard.zoomBy(1),
    zoomOut: () => current?.keyboard.zoomBy(-1),
    resetNorth: () => current?.keyboard.resetNorth(),
    navigationMode: mode,
    setNavigationMode(next: NavigationMode) {
      mode = validNavigationMode(next);
      if (navigationApi) navigationApi.navigationMode = mode;
    },
    northUpMaxLatitudeDeg: maxLatitudeDeg,
    setNorthUpMaxLatitude(deg: number) {
      maxLatitudeDeg = validNorthUpLatitude(deg);
      if (navigationApi) navigationApi.northUpMaxLatitudeDeg = maxLatitudeDeg;
    },
    tiltPolicy: tilt.policy,
    setTiltPolicy: (next: boolean | Partial<TiltPolicy> | null) => tilt.set(next, resolved.maxTiltDeg, navigationApi),
    tiltAvailable: true,
    maxTiltDeg: 90,
    onTiltAvailabilityChange: (listener: (available: boolean) => void) => tilt.listen(listener),
    forwardWheel: (source: EventTarget) => wheels.forward(source),
  });
  Object.defineProperty(controls, 'tiltPolicy', { get: () => tilt.policy, enumerable: true });
  Object.defineProperty(controls, 'tiltAvailable', { get: () => tilt.available, enumerable: true });
  Object.defineProperty(controls, 'maxTiltDeg', { get: () => tilt.maxTiltDeg(navigationApi), enumerable: true });
  // Getters: Object.assign would copy the values once.
  Object.defineProperty(controls, 'northUpMaxLatitudeDeg', { get: () => maxLatitudeDeg, enumerable: true });
  return Object.defineProperty(controls, 'navigationMode', { get: () => mode, enumerable: true });
}

/** One attachment to an input element. */
interface Attached {
  readonly port: CameraPort;
  readonly keyboard: KeyboardInput;
  update(): void;
  /** An API movement starts (F202): inertia, smoothed zooms and held keys stop. */
  interrupt(): void;
  destroy(): void;
}

/** Whether the system asks for reduced motion now; false where the browser cannot tell. */
function reducedMotionQuery(element: HTMLElement): MediaQueryList | undefined {
  return element.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)');
}

function createContext(element: HTMLElement, port: CameraPort, options: ResolvedControlsOptions): GestureContext {
  const query = options.reducedMotion === 'system' ? reducedMotionQuery(element) : undefined;
  const full: InertiaTaus = options.inertia;
  const quarter: InertiaTaus = {
    panTauMs: full.panTauMs / 4,
    rotateTauMs: full.rotateTauMs / 4,
    twistTauMs: full.twistTauMs / 4,
    tiltTauMs: full.tiltTauMs / 4,
    zoomTauMs: full.zoomTauMs / 4,
  };
  const context: GestureContext = {
    port,
    options,
    inertia: new Inertia(),
    zoom: new ZoomTarget(port),
    heading: new HeadingTarget(),
    keys: new KeyMotion(),
    widthPx: () => element.clientWidth,
    heightPx: () => element.clientHeight,
    // The media query is read at each release, so a change of the system setting applies without a reload (F214).
    inertiaTaus: () => (options.reducedMotion === 'reduce' || query?.matches === true ? quarter : full),
    // A smoothed wheel zoom is part of the wheel's own response: it completes while other input goes on.
    interrupt() {
      context.inertia.stop();
      context.heading.stop();
    },
  };
  return context;
}

/** Takes the element for input until the returned function gives it back as it was. */
function takeElement(element: HTMLElement): () => void {
  // The browser must not take drags and pinches over the map for scrolling or page zoom (F189).
  const touchAction = element.style.touchAction;
  element.style.touchAction = 'none';
  // Keyboard navigation needs a focusable map (F213): an application's own canvas may not be.
  const focusable = element.hasAttribute('tabindex');
  if (!focusable) element.tabIndex = 0;
  return () => {
    element.style.touchAction = touchAction;
    if (!focusable) element.removeAttribute('tabindex');
  };
}

function attach(
  element: HTMLElement,
  navigation: NavigationApi,
  options: ResolvedControlsOptions,
  globe: ConnectedGlobe | undefined,
  wheels: WheelForwarding,
): Attached {
  const view = element.ownerDocument.defaultView;
  const port = new CameraPort(navigation, () => view?.performance.now() ?? Date.now());
  port.globe = globe;
  const context = createContext(element, port, options);
  const box = new ZoomBox(element);
  const mouse = new MouseGestures(context, box);
  const touch = new TouchGestures(context);
  const wheel = new WheelInput(context);
  const keyboard = new KeyboardInput(context, () => {
    if (box.drawing) mouse.cancel();
    box.stop();
  });
  const listeners = domListeners(element, port, context, { mouse, touch, wheel, keyboard, box });
  const restore = takeElement(element);
  for (const [target, type, listener] of listeners) target.addEventListener(type, listener, { passive: false });
  const stopWheels = wheels.attach(element, listeners);
  return {
    port,
    keyboard,
    interrupt() {
      context.interrupt();
      context.zoom.stop();
      context.keys.stop();
      keyboard.releaseAll();
    },
    update() {
      const { zoom, inertia, heading, keys } = context;
      // The wheel's zoom goes first, so a drag started during it keeps its grabbed point under the pointer.
      wheel.apply();
      const zooming = zoom.pending !== 0;
      // Every frame reads the engine clock (`NavigationApi.timeInto`, no allocation), so animations start where it was.
      port.beginFrame();
      const now = port.times[FRAME_MS] ?? 0;
      let moving = zooming && zoom.step(now, port);
      mouse.apply();
      touch.apply();
      if (inertia.active || heading.active || keys.moving || box.fitting) {
        moving = inertia.step(now, port) || moving;
        moving = heading.step(now, port, options.maxTiltDeg) || moving;
        const { smoothingMs } = options.keyboard;
        moving = keys.step(now, port, smoothingMs, context.widthPx(), context.heightPx(), options.maxTiltDeg) || moving;
        moving = box.step(now, port) || moving;
      }
      if (moving) port.requestNextFrame();
    },
    destroy() {
      for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
      stopWheels();
      restore();
      box.cancel();
      element.style.outline = '';
    },
  };
}
