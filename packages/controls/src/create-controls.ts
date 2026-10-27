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
  validNavigationMode,
  validNorthUpLatitude,
} from './options.js';
import { TouchGestures } from './touch-gestures.js';
import { WheelInput } from './wheel-input.js';
import { ZoomBox } from './zoom-box.js';
import { domListeners } from './dom-listeners.js';

/** The controls factory with commands for buttons and applications. */
export interface NavigationControls extends ControlsFactory {
  /** The settings in use, defaults filled in. */
  readonly options: ResolvedControlsOptions;
  /**
   * Connects the globe the controls drive, after `createGlobe`: rotation and tilt, and the engine clock for inertia,
   * need it until the engine's navigation interface carries them (docs/parallel-tracks.md, "M6 input" hooks). Without
   * it, pan and zoom work and rotate and tilt gestures are off.
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
   * stops at the poles). Anything else throws a GlobeError ('invalid-option').
   */
  setNavigationMode(mode: NavigationMode): void;
  /** The 'north-up' latitude limit now, degrees (the `northUpMaxLatitudeDeg` option, then the setter below). */
  readonly northUpMaxLatitudeDeg: number;
  /**
   * Sets the highest latitude a 'north-up' camera looks at, degrees from 1 to 89.9, from the next input on; anything
   * else throws a GlobeError ('invalid-option').
   */
  setNorthUpMaxLatitude(deg: number): void;
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
  const factory = (element: unknown, navigation: NavigationApi): Controls => {
    navigationApi = navigation;
    navigation.navigationMode = mode;
    navigation.northUpMaxLatitudeDeg = maxLatitudeDeg;
    const attached = attach(element as HTMLElement, navigation, resolved, globe);
    current = attached;
    return {
      update: attached.update,
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
      globe = target;
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
  });
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
    zoom: new ZoomTarget(),
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

function attach(
  element: HTMLElement,
  navigation: NavigationApi,
  options: ResolvedControlsOptions,
  globe: ConnectedGlobe | undefined,
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
  // The browser must not take drags and pinches over the map for scrolling or page zoom (F189).
  const touchAction = element.style.touchAction;
  element.style.touchAction = 'none';
  // Keyboard navigation needs a focusable map (F213): an application's own canvas may not be.
  const focusable = element.hasAttribute('tabindex');
  if (!focusable) element.tabIndex = 0;
  for (const [target, type, listener] of listeners) target.addEventListener(type, listener, { passive: false });
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
      element.style.touchAction = touchAction;
      if (!focusable) element.removeAttribute('tabindex');
      box.cancel();
      element.style.outline = '';
    },
  };
}
