// The controls harness page (e2e/support/controls.html): a globe with @vibeglobe/controls connected, driven by the M6
// input track's end-to-end tests through `window.controlsHarness`. Public API only.
import { createControls, type ControlsOptions, type NavigationControls } from '@vibeglobe/controls';
import { createGlobe, type CameraState, type GeoPosition, type Globe, type ScreenPoint } from '@vibeglobe/core';
import { createRenderer } from '@vibeglobe/renderer';

/** One drawn frame as the recorder saw it. */
export interface RecordedFrame {
  readonly frameNumber: number;
  readonly timeMs: number;
  readonly camera: CameraState;
  /** Where each tracked position shows (null when behind the globe). */
  readonly screens: (ScreenPoint | null)[];
  /** The position at each tracked screen point (null off the globe). */
  readonly positions: (GeoPosition | null)[];
  /** The latest pointer position, or the midpoint of the touches down, in canvas pixels (null with none down). */
  readonly pointer: ScreenPoint | null;
}

/** The page's test hooks. */
export interface ControlsHarness {
  readonly globe: Globe;
  readonly controls: NavigationControls;
  /** Records every frame from now on, with the given positions and screen points tracked. */
  record(positions: readonly GeoPosition[], points?: readonly ScreenPoint[]): void;
  /** Stops recording and returns the frames. */
  frames(): RecordedFrame[];
}

declare global {
  interface Window {
    controlsHarness?: ControlsHarness;
  }
}

const params = new URLSearchParams(location.search);
if (params.has('embed')) document.body.classList.add('embed');
// `?size=WxH` sets the map's CSS size (default 800x600).
const size = /^(\d+)x(\d+)$/.exec(params.get('size') ?? '');
const container = document.querySelector<HTMLDivElement>('#app');
const canvas = document.querySelector<HTMLCanvasElement>('#globe');
if (!container || !canvas) throw new Error('The harness page lost its map');
if (size) {
  container.style.width = `${size[1]}px`;
  container.style.height = `${size[2]}px`;
}
const number = (name: string): number | undefined => (params.has(name) ? Number(params.get(name)) : undefined);
const backend = params.get('backend');
const options = params.has('options') ? (JSON.parse(params.get('options') ?? '{}') as ControlsOptions) : {};
const controls = createControls(options);
const view = {
  longitudeDeg: number('lon') ?? 10,
  latitudeDeg: number('lat') ?? 45,
  zoom: number('zoom') ?? 3,
  headingDeg: number('heading') ?? 0,
  tiltDeg: number('tilt') ?? 0,
};
const clockStepMs = number('clockStepMs');
const globe = createGlobe({
  container,
  renderer: createRenderer({ backend: backend === 'webgpu' || backend === 'webgl2' ? backend : 'auto', canvas }),
  controls,
  baseImageryUrl: '/imagery/natural-earth-4096.jpg',
  view,
  ...(clockStepMs === undefined ? {} : { manualClockStepMs: clockStepMs }),
});
controls.connect(globe);

/** Pointers down, by id, in canvas pixels. */
const down = new Map<number, ScreenPoint>();
const track = (event: PointerEvent): void => {
  const rect = canvas.getBoundingClientRect();
  if (event.type === 'pointerup' || event.type === 'pointercancel') down.delete(event.pointerId);
  else if (event.type === 'pointerdown' || down.has(event.pointerId)) {
    down.set(event.pointerId, { xPx: event.clientX - rect.left, yPx: event.clientY - rect.top });
  }
};
for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
  container.addEventListener(type, track as EventListener, { capture: true });
}
function pointer(): ScreenPoint | null {
  if (down.size === 0) return null;
  let x = 0;
  let y = 0;
  for (const point of down.values()) {
    x += point.xPx;
    y += point.yPx;
  }
  return { xPx: x / down.size, yPx: y / down.size };
}

let recorded: RecordedFrame[] = [];
let stopRecording: (() => void) | undefined;
window.controlsHarness = {
  globe,
  controls,
  record(positions, points = []) {
    stopRecording?.();
    recorded = [];
    stopRecording = globe.on('frame', ({ frameNumber }) => {
      recorded.push({
        frameNumber,
        timeMs: globe.timeMs,
        camera: { ...globe.camera },
        screens: positions.map((position) => globe.geoToScreen(position) ?? null),
        positions: points.map((point) => globe.screenToGeo(point) ?? null),
        pointer: pointer(),
      });
    });
  },
  frames() {
    stopRecording?.();
    stopRecording = undefined;
    return recorded;
  },
};
