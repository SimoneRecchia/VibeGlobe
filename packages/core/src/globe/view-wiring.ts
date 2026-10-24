import type { Camera } from '../camera/camera.js';
import type { ViewState } from '../view/view-state.js';
import { currentView } from './camera-state.js';
import type { Constraints } from './constraints.hot.js';
import type { Emitter } from './emitter.js';
import type { EngineClock } from './engine-clock.js';
import { Movements } from './movements.js';
import type { GlobeEvents } from './types.js';
import { ViewControl } from './view-control.js';

/** What {@link wireView} needs from its globe. */
export interface ViewWiring {
  readonly cam: Camera;
  /** The surface: its view state, and the tiles a flight's destination needs (F286). */
  readonly surface: {
    readonly view: ViewState;
    preloadView(end: Float64Array | undefined, camera: Camera, flight?: boolean): void;
    preloadAhead(end: Float64Array, camera: Camera): void;
    cameraJumped(): void;
  };
  readonly emitter: Emitter<GlobeEvents>;
  readonly clock: EngineClock;
  readonly constraints: Constraints;
  setOpacity(opacity: number): void;
  waiting(): boolean;
  assertAlive(): void;
  requestRender(): void;
}

/** The view API and the camera movements of a globe, wired to each other: input intents interrupt movements. */
export function wireView(globe: ViewWiring): { viewControl: ViewControl; movements: Movements } {
  const viewControl: ViewControl = new ViewControl({
    cam: globe.cam,
    view: globe.surface.view,
    emitter: globe.emitter,
    waiting: () => globe.waiting(),
    assertAlive: () => globe.assertAlive(),
    requestRender: () => globe.requestRender(),
    userInput: (cause) => movements.userInput(cause),
    timeMs: () => globe.clock.timeMs,
    timeInto: (out) => globe.clock.timeInto(out),
    limitZoom: (deltaZoom) => globe.constraints.limitZoomDelta(globe.cam, deltaZoom),
    interruptMovement: () => movements.interrupt(),
  });
  const movements: Movements = new Movements({
    cam: globe.cam,
    view: globe.surface.view,
    assertAlive: () => globe.assertAlive(),
    emitter: globe.emitter,
    timeMs: () => globe.clock.timeMs,
    currentView: () => currentView(globe.cam),
    chooseTilt: (tiltDeg) => viewControl.chooseTilt(tiltDeg),
    setMode: (mode) => viewControl.setMode(mode),
    animateTilt: (tiltRad) => globe.surface.view.chooseTilt(tiltRad),
    setOpacity: (opacity) => globe.setOpacity(opacity),
    requestRender: () => globe.requestRender(),
    interruptInput: () => viewControl.slot.controls?.interrupt?.(),
    constrainEnd: (end) => globe.constraints.clampEnd(end),
    preloadView: (end, flight) => globe.surface.preloadView(end, globe.cam, flight),
    preloadAhead: (end) => globe.surface.preloadAhead(end, globe.cam),
    cameraJumped: () => globe.surface.cameraJumped(),
  });
  return { viewControl, movements };
}
