import type { Camera } from '../camera/camera.js';
import { CameraAnimator, type AnimationKind } from '../camera/camera-animator.js';
import { FadeJump } from '../camera/fade-jump.js';
import { Orbit } from '../camera/orbit.js';
import {
  groundZoomForRange,
  groundZoomFromMercatorZoom,
  mercatorZoomFromGroundZoom,
  rangeForGroundZoom,
} from '../camera/zoom.js';
import { WGS84 } from '../geodesy/wgs84.js';
import type { Emitter } from './emitter.js';
import { GlobeError } from './errors.js';
import type {
  CameraMovement,
  GeoBounds,
  GeoPosition,
  HomeView,
  GlobeEvents,
  MoveCause,
  MoveOutcome,
  MovementOptions,
  TourWaypoint,
  ViewInit,
} from './types.js';
import type { AbortSignalLike } from './imagery-runtime.js';
import { validateBounds, viewForBounds } from './fit-bounds.js';
import { validatePosition, validateView, type ValidView } from './validation.js';
import { applyView, currentView } from './camera-state.js';
import { keepGroundScale } from './view-geometry.js';
import type { EngineClock } from './engine-clock.js';
import type { ViewState } from '../view/view-state.js';
import { ViewControl } from './view-control.js';

const RAD = Math.PI / 180;
/** How long a flight's fade takes under the reduced-motion setting (F214), milliseconds. */
const REDUCED_MOTION_FADE_MS = 300;

/** What camera movements need from their globe. */
export interface MovementHost {
  readonly cam: Camera;
  readonly view: ViewState;
  readonly emitter: Emitter<GlobeEvents>;
  /** Throws once the globe is destroyed. */
  assertAlive(): void;
  /** The engine clock's time of the frame being drawn, milliseconds. */
  timeMs(): number;
  /** The current view as validated fields, the base of a partial target. */
  currentView(): ValidView;
  /** A target with a tilt chooses it: manual mode (ADR 0034). */
  chooseTilt(tiltDeg: number): void;
  /** Sets the view mode (F163), as the home view asks. */
  setMode(mode: '2d' | '3d' | 'auto'): void;
  /** Sets the chosen tilt a movement animates, without a mode change. */
  animateTilt(tiltRad: number): void;
  /** Shows the view at this opacity (1 opaque): a reduced-motion flight's fade (F214). */
  setOpacity(opacity: number): void;
  requestRender(): void;
}

/** A running animation: an ease or flight, or an orbit (F192). */
interface Animation {
  readonly animatesTilt: boolean;
  /** The view's opacity while the animation runs, for a reduced-motion fade (F214); undefined keeps it opaque. */
  readonly opacity?: number;
  step(camera: Camera, io: Float64Array): boolean;
}

interface Running {
  readonly animator: Animation;
  readonly settle: (outcome: MoveOutcome) => void;
  readonly detach: () => void;
}

/**
 * The camera movements of a globe (F195–F203, ADR 0036): one at a time, stepped at the start of each frame on the
 * engine clock, announced with `movestart`, `move` and `moveend`, each settling its promise exactly once. User input
 * reported through {@link userInput} interrupts the running movement and is announced with the cause 'user'.
 */
export class Movements {
  private running: Running | undefined;
  /** A movement started this frame: it begins at the frame's clock time, not before. */
  private readonly stepIo = new Float64Array(2);
  private readonly moveEvent = { cause: 'api' as MoveCause };
  private userMoving = false;
  private userInputThisFrame = false;
  /**
   * The system's reduced-motion setting (F214), followed at runtime: flights then fade to their target instead of
   * traversing the path. Input inertia reads it too (`Globe.reducedMotion`).
   */
  reducedMotion = false;

  constructor(private readonly host: MovementHost) {}

  /** True while a movement runs: the frame loop keeps drawing. */
  get active(): boolean {
    return this.running !== undefined;
  }

  /** Starts an ease or a flight; invalid input rejects with a GlobeError and moves nothing. */
  start(kind: AnimationKind, target: ViewInit, options: MovementOptions | undefined): CameraMovement {
    this.host.assertAlive();
    let view: ValidView;
    let durationMs: number | undefined;
    try {
      view = validateView(target, this.host.currentView());
      durationMs = validDuration(options?.durationMs);
      validSignal(options?.signal);
    } catch (error) {
      return rejected(error);
    }
    this.interrupt();
    const camera = this.host.cam;
    const end = Float64Array.of(
      view.longitudeDeg * RAD,
      view.latitudeDeg * RAD,
      rangeForGroundZoom(
        groundZoomFromMercatorZoom(view.zoom, view.latitudeDeg * RAD),
        camera.heightPx,
        camera.fovYRad,
      ),
      view.headingDeg * RAD,
      target.tiltDeg === undefined ? Number.NaN : view.tiltDeg * RAD,
    );
    if (target.tiltDeg !== undefined) this.host.chooseTilt(camera.pose.tiltRad / RAD);
    const animator =
      kind === 'fly' && this.reducedMotion
        ? new FadeJump(camera, end, this.host.timeMs(), REDUCED_MOTION_FADE_MS)
        : new CameraAnimator(kind, camera, end, this.host.timeMs(), durationMs);
    return this.begin(animator, options?.signal);
  }

  /**
   * Orbits the camera about `center` (by default its target) at `degreesPerSecond` (default 10) until cancelled,
   * interrupted or replaced (F192).
   */
  orbit(
    options:
      | { readonly center?: GeoPosition; readonly degreesPerSecond?: number; readonly signal?: AbortSignalLike }
      | undefined,
  ): CameraMovement {
    this.host.assertAlive();
    const camera = this.host.cam;
    const center = Float64Array.of(camera.pose.targetLongitudeRad, camera.pose.targetLatitudeRad);
    let rate: number;
    try {
      if (options?.center !== undefined) {
        validatePosition(options.center);
        center[0] = options.center.longitudeDeg * RAD;
        center[1] = options.center.latitudeDeg * RAD;
      }
      rate = options?.degreesPerSecond ?? 10;
      if (typeof rate !== 'number' || !Number.isFinite(rate))
        throw new GlobeError('invalid-option', `degreesPerSecond must be a finite number, got ${String(rate)}`);
      validSignal(options?.signal);
    } catch (error) {
      return rejected(error);
    }
    this.interrupt();
    return this.begin(new Orbit(camera, center, rate * RAD, this.host.timeMs()), options?.signal);
  }

  /** Turns to a heading along the shorter arc, keeping center and tilt (F191). */
  rotateTo(headingDeg: number, options: MovementOptions | undefined): CameraMovement {
    this.host.assertAlive();
    return this.start('ease', { headingDeg }, options);
  }

  /** Flies out to the whole globe over the current location (F193): the eye three Earth radii from the target. */
  resetToGlobe(options: MovementOptions | undefined): CameraMovement {
    this.host.assertAlive();
    const camera = this.host.cam;
    const latitudeRad = camera.pose.targetLatitudeRad;
    const zoom = mercatorZoomFromGroundZoom(
      groundZoomForRange(3 * WGS84.semiMajorAxisMeters, camera.heightPx, camera.fovYRad),
      latitudeRad,
    );
    const view = this.host.currentView();
    return this.start('fly', { longitudeDeg: view.longitudeDeg, latitudeDeg: view.latitudeDeg, zoom }, options);
  }

  /** Flies to the home view, setting its view mode first (F194). */
  goHome(home: HomeView, options: MovementOptions | undefined): CameraMovement {
    this.host.assertAlive();
    if (home.viewMode !== undefined) this.host.setMode(home.viewMode);
    // The view mode is no view field: validation reads only those.
    return this.start('fly', home, options);
  }

  /** Starts a validated animation: its promise, events and signal (ADR 0036). */
  private begin(animator: Animation, signal: AbortSignalLike | undefined): CameraMovement {
    let settle: (outcome: MoveOutcome) => void = () => undefined;
    const promise = new Promise<MoveOutcome>((resolve) => {
      settle = resolve;
    }) as CameraMovement;
    const onAbort = (): void => this.finish(running, 'cancelled');
    const running: Running = {
      animator,
      settle: (outcome) => settle(outcome),
      detach: () => signal?.removeEventListener('abort', onAbort),
    };
    promise.cancel = () => this.finish(running, 'cancelled');
    this.running = running;
    this.moveEvent.cause = 'api';
    this.host.emitter.emit('movestart', { cause: 'api' });
    if (signal?.aborted) this.finish(running, 'cancelled');
    else signal?.addEventListener('abort', onAbort);
    this.host.requestRender();
    return promise;
  }

  /** Flies or eases to the view that shows `bounds` inside the padded viewport (F176). */
  fitBounds(
    bounds: GeoBounds,
    options: (MovementOptions & { readonly paddingPx?: number; readonly movement?: 'fly' | 'ease' }) | undefined,
  ): CameraMovement {
    this.host.assertAlive();
    const camera = this.host.cam;
    let target;
    try {
      const valid = validateBounds(bounds);
      const padding = options?.paddingPx ?? 0;
      if (typeof padding !== 'number' || !(padding >= 0) || 2 * padding >= Math.min(camera.widthPx, camera.heightPx))
        throw new GlobeError('invalid-option', `paddingPx must leave part of the viewport, got ${String(padding)}`);
      if (options?.movement !== undefined && options.movement !== 'fly' && options.movement !== 'ease')
        throw new GlobeError('invalid-option', `movement must be 'fly' or 'ease', got ${String(options.movement)}`);
      target = viewForBounds(camera, this.host.view, valid, padding);
    } catch (error) {
      return rejected(error);
    }
    return this.start(options?.movement ?? 'fly', target, options);
  }

  /** Plays a tour (F199): each leg a movement, then its dwell, announcing each waypoint. */
  tour(waypoints: readonly TourWaypoint[], options: { readonly signal?: AbortSignalLike } | undefined): CameraMovement {
    this.host.assertAlive();
    try {
      if (!Array.isArray(waypoints) || waypoints.length === 0)
        throw new GlobeError('invalid-option', 'A tour needs at least one waypoint');
      for (const waypoint of waypoints) {
        validateView(waypoint?.target, this.host.currentView());
        if (waypoint.movement !== undefined && !['fly', 'ease', 'jump'].includes(waypoint.movement))
          throw new GlobeError('invalid-option', `A waypoint's movement is 'fly', 'ease' or 'jump'`);
        validDuration(waypoint.durationMs);
        validDuration(waypoint.dwellMs);
      }
    } catch (error) {
      return rejected(error);
    }
    let current: CameraMovement | undefined;
    let cancelled = false;
    const leg = async (movement: CameraMovement): Promise<MoveOutcome> => {
      current = movement;
      const outcome = await movement;
      return cancelled ? 'cancelled' : outcome;
    };
    const run = async (): Promise<MoveOutcome> => {
      for (const [index, waypoint] of waypoints.entries()) {
        if (cancelled) return 'cancelled';
        if (waypoint.movement === 'jump') this.jump(waypoint.target, undefined, false);
        else {
          const outcome = await leg(
            this.start(waypoint.movement ?? 'fly', waypoint.target, { durationMs: waypoint.durationMs }),
          );
          if (outcome !== 'completed') return outcome;
        }
        this.host.emitter.emit('tour-waypoint', { index });
        if ((waypoint.dwellMs ?? 0) > 0) {
          // A dwell holds the view on the engine clock: an ease to where the camera is.
          const outcome = await leg(this.start('ease', {}, { durationMs: waypoint.dwellMs }));
          if (outcome !== 'completed') return outcome;
        }
      }
      return 'completed';
    };
    const promise = run() as CameraMovement;
    promise.cancel = () => {
      cancelled = true;
      current?.cancel();
    };
    const signal = options?.signal;
    if (signal?.aborted) promise.cancel();
    else signal?.addEventListener('abort', () => promise.cancel());
    return promise;
  }

  /** Interrupts the running movement, if any: it settles as 'interrupted' where the last frame left it. */
  interrupt(): void {
    if (this.running) this.finish(this.running, 'interrupted');
  }

  /** Called by the navigation intents: user input takes over (F202) and is announced with the cause 'user'. */
  userInput(): void {
    this.interrupt();
    this.userInputThisFrame = true;
    if (!this.userMoving) {
      this.userMoving = true;
      this.host.emitter.emit('movestart', { cause: 'user' });
    }
  }

  /**
   * Steps the running movement to the frame's clock time (call at the start of each frame, before the controls), and
   * announces this frame's movement. Allocates nothing.
   */
  step(): void {
    const running = this.running;
    if (running) {
      this.stepIo[0] = this.host.timeMs();
      const done = running.animator.step(this.host.cam, this.stepIo);
      if (running.animator.animatesTilt) this.host.animateTilt(this.stepIo[1] ?? 0);
      const opacity = running.animator.opacity;
      if (opacity !== undefined) this.host.setOpacity(opacity);
      this.host.cam.update();
      this.moveEvent.cause = 'api';
      if (this.host.emitter.has('move')) this.host.emitter.emit('move', this.moveEvent);
      if (done) this.finish(running, 'completed');
    }
  }

  /** Called after the controls ran in a frame: a user movement with no input this frame has ended. */
  afterInput(): void {
    if (this.userInputThisFrame) {
      this.moveEvent.cause = 'user';
      if (this.host.emitter.has('move')) this.host.emitter.emit('move', this.moveEvent);
    } else if (this.userMoving) {
      this.userMoving = false;
      this.host.emitter.emit('moveend', { cause: 'user', outcome: 'completed' });
    }
    this.userInputThisFrame = false;
  }

  /**
   * jumpTo (F197): moves the camera in one frame and announces the three movement events. While there is no viewport
   * (`pending`, or a `collapsed` container and a jump with a zoom) the view is returned to be kept as the request
   * instead (KB-046; a jump without a zoom keeps the range and needs none, KB-056). Invalid input throws a GlobeError,
   * also emitted as an error event, and changes nothing.
   */
  jump(target: ViewInit, pending: ValidView | undefined, collapsed: boolean): ValidView | undefined {
    const camera = this.host.cam;
    const keepRange = typeof target === 'object' && target !== null && target.zoom === undefined;
    const request = pending ?? (collapsed && !keepRange ? currentView(camera) : undefined);
    let view;
    try {
      view = validateView(target, request ?? currentView(camera));
    } catch (error) {
      if (error instanceof GlobeError) this.host.emitter.emit('error', error);
      throw error;
    }
    // A view given with a tilt chooses it (manual mode, ADR 0034).
    if (target.tiltDeg !== undefined) this.host.chooseTilt(view.tiltDeg);
    if (request) {
      // A position-only jump keeps the ground scale, as it does after start.
      if (keepRange) keepGroundScale(request, view);
      return view;
    }
    applyView(camera, view, keepRange);
    camera.update();
    this.jumped();
    this.host.requestRender();
    return undefined;
  }

  /** A jump: the three events in one go (F197). */
  private jumped(): void {
    this.interrupt();
    this.host.emitter.emit('movestart', { cause: 'api' });
    this.moveEvent.cause = 'api';
    this.host.emitter.emit('move', this.moveEvent);
    this.host.emitter.emit('moveend', { cause: 'api', outcome: 'completed' });
  }

  /** Ends the movement and settles its promise, once. */
  private finish(running: Running, outcome: MoveOutcome): void {
    if (this.running !== running) return;
    this.running = undefined;
    running.detach();
    // A fade cut short still leaves the view opaque.
    if (running.animator.opacity !== undefined) this.host.setOpacity(1);
    this.host.emitter.emit('moveend', { cause: 'api', outcome });
    running.settle(outcome);
    this.host.requestRender();
  }
}

/** Throws unless `signal` is undefined or an AbortSignal. */
function validSignal(signal: unknown): void {
  if (signal !== undefined && (typeof signal !== 'object' || signal === null || !('aborted' in signal)))
    throw new GlobeError('invalid-option', 'A movement signal must be an AbortSignal');
}

/** A movement that failed validation: rejected, with nothing to cancel. */
function rejected(error: unknown): CameraMovement {
  const promise = Promise.reject(error) as CameraMovement;
  promise.cancel = () => undefined;
  return promise;
}

/** A duration in milliseconds, 0 or more and finite, or undefined for the automatic one. */
function validDuration(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new GlobeError(
      'invalid-option',
      `A movement's durationMs must be a finite number of 0 or more, got ${String(value)}`,
    );
  return value;
}

/** What {@link wireView} needs from its globe. */
export interface ViewWiring {
  readonly cam: Camera;
  readonly view: ViewState;
  readonly emitter: Emitter<GlobeEvents>;
  readonly clock: EngineClock;
  setOpacity(opacity: number): void;
  waiting(): boolean;
  assertAlive(): void;
  requestRender(): void;
}

/** The view API and the camera movements of a globe, wired to each other: input intents interrupt movements. */
export function wireView(globe: ViewWiring): { viewControl: ViewControl; movements: Movements } {
  const viewControl: ViewControl = new ViewControl({
    cam: globe.cam,
    view: globe.view,
    emitter: globe.emitter,
    waiting: () => globe.waiting(),
    assertAlive: () => globe.assertAlive(),
    requestRender: () => globe.requestRender(),
    userInput: () => movements.userInput(),
  });
  const movements: Movements = new Movements({
    cam: globe.cam,
    view: globe.view,
    assertAlive: () => globe.assertAlive(),
    emitter: globe.emitter,
    timeMs: () => globe.clock.timeMs,
    currentView: () => currentView(globe.cam),
    chooseTilt: (tiltDeg) => viewControl.chooseTilt(tiltDeg),
    setMode: (mode) => viewControl.setMode(mode),
    animateTilt: (tiltRad) => globe.view.chooseTilt(tiltRad),
    setOpacity: (opacity) => globe.setOpacity(opacity),
    requestRender: () => globe.requestRender(),
  });
  return { viewControl, movements };
}

/** A movement that has already settled as 'completed': what a jump returns (F197, F200). */
export function completedMovement(): CameraMovement {
  const movement = Promise.resolve<MoveOutcome>('completed') as CameraMovement;
  movement.cancel = () => undefined;
  return movement;
}
