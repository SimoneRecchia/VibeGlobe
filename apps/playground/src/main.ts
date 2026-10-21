import { createControls } from '@vibeglobe/controls';
import { createGlobe, WGS84, type Globe, type ViewInit } from '@vibeglobe/core';
import { createRenderer, type BackendChoice, type DepthChoice } from '@vibeglobe/renderer';
import { startFrameLoop, type FrameLoop } from './frame-loop.js';
import { instrumentMainThread, startWorkerRendering } from './render-experiment/page.js';
import { runScenario } from './scenarios.js';
import { exposeTestHooks } from './test-hooks.js';

const OVERLAY_REFRESH_MS = 250;

const params = new URLSearchParams(location.search);
const app = document.querySelector<HTMLDivElement>('#app');
const canvas = document.querySelector<HTMLCanvasElement>('#globe');
const status = document.querySelector<HTMLParagraphElement>('#status');
const cursor = document.querySelector<HTMLParagraphElement>('#cursor');

/** The initial view from the URL (`?lon=&lat=&zoom=&heading=&tilt=`), each optional. */
function viewFromUrl(): ViewInit {
  const view: Record<string, number> = {};
  for (const [param, field] of [
    ['lon', 'longitudeDeg'],
    ['lat', 'latitudeDeg'],
    ['zoom', 'zoom'],
    ['heading', 'headingDeg'],
    ['tilt', 'tiltDeg'],
  ] as const) {
    const value = params.get(param);
    if (value !== null) view[field] = Number(value);
  }
  return view;
}

const backendParam = params.get('backend');
const backend: BackendChoice = backendParam === 'webgpu' || backendParam === 'webgl2' ? backendParam : 'auto';
const depth: DepthChoice = params.get('depth') === 'fragment' ? 'fragment' : 'auto';

/** Creates one engine instance in a container with its own canvas. */
function startGlobe(container: HTMLElement, target: HTMLCanvasElement, view: ViewInit): Globe {
  return createGlobe({
    container,
    renderer: createRenderer({ backend, depth, canvas: target }),
    controls: createControls(),
    baseImageryUrl: `${import.meta.env.BASE_URL}imagery/natural-earth-4096.jpg`,
    view,
  });
}

/**
 * Shows the coordinates under the pointer (F048). The listener sits on the container: after a device loss or a
 * backend fallback the renderer replaces its canvas, keeping its id.
 */
function showCursorReadout(globe: Globe, container: HTMLElement): void {
  container.addEventListener('pointermove', (event) => {
    const target = container.querySelector('#globe');
    if (!cursor || !target) return;
    const rect = target.getBoundingClientRect();
    const position = globe.screenToGeo({ xPx: event.clientX - rect.left, yPx: event.clientY - rect.top });
    cursor.textContent = position
      ? `${position.latitudeDeg.toFixed(6)}°, ${position.longitudeDeg.toFixed(6)}°`
      : 'Off the globe';
  });
}

/** The second globe of the two-instance scenario (F069), sharing the page with the first. */
function startSecondGlobe(host: HTMLElement): Globe {
  const second = document.createElement('div');
  second.id = 'app-2';
  second.style.cssText = 'position:absolute;top:0;right:0;width:50%;height:100%';
  const secondCanvas = document.createElement('canvas');
  secondCanvas.id = 'globe-2';
  secondCanvas.setAttribute('aria-label', 'Second map');
  second.append(secondCanvas);
  host.style.width = '50%';
  host.after(second);
  return startGlobe(second, secondCanvas, { longitudeDeg: 139.7, latitudeDeg: 35.7, zoom: 2 });
}

async function startDebugOverlay(globe: Globe, host: HTMLElement): Promise<FrameLoop> {
  // Loaded on demand so the overlay code is not part of the default page.
  const { createDebugOverlay } = await import('@vibeglobe/ui');
  const overlay = createDebugOverlay(host);
  let info: (readonly [string, string])[] = [];
  let pipelineCompiles = -1;
  void globe.ready.then(() => {
    const caps = globe.capabilities;
    if (!caps) return;
    info = [
      ['backend', `backend ${caps.backend}`],
      ['max-texture-size', `max texture ${caps.maxTextureSize}`],
      ['max-anisotropy', `anisotropy ${caps.maxAnisotropy}`],
      ['compressed-formats', `compressed ${caps.compressedTextureFormats.join(', ') || 'none'}`],
      ['device-memory', `memory ${caps.deviceMemoryGiB === undefined ? 'unknown' : `${caps.deviceMemoryGiB} GiB`}`],
      ['adapter', `adapter ${caps.adapter}`],
      ['depth', `depth ${caps.depthPath} ${caps.depthFormat}`],
    ];
  });
  let lastRefreshMs = -Infinity;
  return startFrameLoop((stats, timestampMs) => {
    if (timestampMs - lastRefreshMs < OVERLAY_REFRESH_MS) return;
    lastRefreshMs = timestampMs;
    overlay.update({ frameTimeMs: stats.meanFrameTimeMs, framesPerSecond: stats.framesPerSecond });
    // Pipelines compiled after the warm-up stay 0 in normal use (ADR 0010 §4).
    const compiles = info.length > 0 ? globe.rendererStats().pipelineCompiles : -1;
    if (compiles === pipelineCompiles) return;
    pipelineCompiles = compiles;
    overlay.setInfo([...info, ['pipeline-compiles', `pipelines after warm-up ${compiles}`]]);
  });
}

const experiment = params.get('experiment') === 'offscreen' ? params.get('render') : null;

if (app && canvas && experiment === 'worker') {
  // F065: the engine renders in a worker (ADR 0011); the page keeps only the overlay and forwards input.
  startWorkerRendering(app, canvas, {
    backend,
    view: viewFromUrl(),
    imageryUrl: `${import.meta.env.BASE_URL}imagery/natural-earth-4096.jpg`,
  });
} else if (app && canvas) {
  const scenario = params.get('scenario');
  const globe = startGlobe(app, canvas, viewFromUrl());
  // Navigation start is the page's time origin: this is the time to the first complete frame (F546).
  // A failed start records no time (the error reaches the status line and the error event, not a rejection here).
  const firstFrame = globe.ready.then(
    () => performance.now(),
    () => undefined,
  );
  const globes = scenario === 'two-globes' ? [globe, startSecondGlobe(app)] : [globe];
  showCursorReadout(globe, app);
  runScenario(globe, scenario);
  if (experiment === 'main') instrumentMainThread(globe, app);
  const setStatus = (text: string): void => {
    if (status) status.textContent = text;
  };
  setStatus(`Starting… Reference ellipsoid: WGS84, a = ${WGS84.semiMajorAxisMeters} m.`);
  globe.ready.then(
    () => setStatus(`${globe.backend ?? ''} · WGS84, a = ${WGS84.semiMajorAxisMeters} m · Made with Natural Earth`),
    (error: unknown) =>
      setStatus(`The globe could not start: ${error instanceof Error ? error.message : String(error)}`),
  );
  let loop: FrameLoop | undefined;
  if (params.has('debug')) loop = await startDebugOverlay(globe, app);
  else if (scenario === 'frame-loop') loop = startFrameLoop(() => undefined);
  exposeTestHooks(globes, loop, firstFrame);
}
