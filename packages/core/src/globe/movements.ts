import type { Camera } from '../camera/camera.js';
import { CameraAnimator, type AnimationKind } from '../camera/camera-animator.js';
import { groundZoomFromMercatorZoom, rangeForGroundZoom } from '../camera/zoom.js';
import type { Emitter } from './emitter.js';
import { GlobeError } from './errors.js';
import type { CameraMovement, GlobeEvents, MoveCause, MoveOutcome, MovementOptions, ViewInit } from './types.js';
import { validateView, type ValidView } from './validation.js';
import { applyView, currentView } from './camera-state.js';
import { keepGroundScale } from './view-geometry.js';
import type { EngineClock } from './engine-clock.js';
import type { ViewState } from '../view/view-state.js';
import { ViewControl } from './view-control.js';

const RAD = Math.PI / 180;

/** What camera movements need from their globe. */
export interface MovementHost {
  readonly cam: Camera;
  readonly emitter: Emitter<GlobeEvents>;
  /** The engine clock's time of the frame being drawn, milliseconds. */
  timeMs(): number;
  /** The current view as validated fields, the base of a partial target. */
  currentView(): ValidView;
  /** A target with a tilt chooses it: manual mode (ADR 0034). */
  chooseTilt(tiltDeg: number): void;
  /** Sets the chosen tilt a movement animates, without a mode change. */
  animateTilt(tiltRad: number): void;
  requestRender(): void;
}

interface Running {
  readonly animator: CameraAnimator;
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

  constructor(private readonly host: MovementHost) {}

  /** True while a movement runs: the frame loop keeps drawing. */
  get active(): boolean {
    return this.running !== undefined;
  }

  /** Starts an ease or a flight; invalid input rejects with a GlobeError and moves nothing. */
  start(kind: AnimationKind, target: ViewInit, options: MovementOptions | undefined): CameraMovement {
    let settle: (outcome: MoveOutcome) => void = () => undefined;
    let cancel = (): void => undefined;
    const promise = new Promise<MoveOutcome>((resolve) => {
      settle = resolve;
    }) as CameraMovement;
    promise.cancel = () => cancel();
    let view: ValidView;
    let durationMs: number | undefined;
    try {
      view = validateView(target, this.host.currentView());
      durationMs = validDuration(options?.durationMs);
      if (
        options?.signal !== undefined &&
        (typeof options.signal !== 'object' || options.signal === null || !('aborted' in options.signal))
      )
        throw new GlobeError('invalid-option', 'A movement signal must be an AbortSignal');
    } catch (error) {
      const rejected = Promise.reject(error) as CameraMovement;
      rejected.cancel = () => undefined;
      return rejected;
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
    const animator = new CameraAnimator(kind, camera, end, this.host.timeMs(), durationMs);
    const signal = options?.signal;
    const onAbort = (): void => this.finish(running, 'cancelled');
    const running: Running = {
      animator,
      settle: (outcome) => settle(outcome),
      detach: () => signal?.removeEventListener('abort', onAbort),
    };
    cancel = () => this.finish(running, 'cancelled');
    this.running = running;
    this.moveEvent.cause = 'api';
    this.host.emitter.emit('movestart', { cause: 'api' });
    if (signal?.aborted) this.finish(running, 'cancelled');
    else signal?.addEventListener('abort', onAbort);
    this.host.requestRender();
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
    this.host.emitter.emit('moveend', { cause: 'api', outcome });
    running.settle(outcome);
    this.host.requestRender();
  }
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
    emitter: globe.emitter,
    timeMs: () => globe.clock.timeMs,
    currentView: () => currentView(globe.cam),
    chooseTilt: (tiltDeg) => viewControl.chooseTilt(tiltDeg),
    animateTilt: (tiltRad) => globe.view.chooseTilt(tiltRad),
    requestRender: () => globe.requestRender(),
  });
  return { viewControl, movements };
}
