import { createControls } from '@vibeglobe/controls';
import { createGlobe, WGS84, type Globe, type ViewInit } from '@vibeglobe/core';
import { createRenderer, type BackendChoice } from '@vibeglobe/renderer';
import { startFrameLoop, type FrameLoop } from './frame-loop.js';
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

/** Creates one engine instance in a container with its own canvas. */
function startGlobe(container: HTMLElement, target: HTMLCanvasElement, view: ViewInit): Globe {
  return createGlobe({
    container,
    renderer: createRenderer({ backend, canvas: target }),
    controls: createControls(),
    baseImageryUrl: `${import.meta.env.BASE_URL}imagery/natural-earth-4096.jpg`,
    view,
  });
}

/** Shows the coordinates under the pointer (F048). */
function showCursorReadout(globe: Globe, target: HTMLCanvasElement): void {
  target.addEventListener('pointermove', (event) => {
    if (!cursor) return;
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
  void globe.ready.then(() => {
    const caps = globe.capabilities;
    if (!caps) return;
    overlay.setInfo([
      ['backend', `backend ${caps.backend}`],
      ['max-texture-size', `max texture ${caps.maxTextureSize}`],
      ['max-anisotropy', `anisotropy ${caps.maxAnisotropy}`],
      ['compressed-formats', `compressed ${caps.compressedTextureFormats.join(', ') || 'none'}`],
      ['device-memory', `memory ${caps.deviceMemoryGiB === undefined ? 'unknown' : `${caps.deviceMemoryGiB} GiB`}`],
      ['adapter', `adapter ${caps.adapter}`],
    ]);
  });
  let lastRefreshMs = -Infinity;
  return startFrameLoop((stats, timestampMs) => {
    if (timestampMs - lastRefreshMs < OVERLAY_REFRESH_MS) return;
    lastRefreshMs = timestampMs;
    overlay.update({ frameTimeMs: stats.meanFrameTimeMs, framesPerSecond: stats.framesPerSecond });
  });
}

if (app && canvas) {
  const scenario = params.get('scenario');
  const globe = startGlobe(app, canvas, viewFromUrl());
  const globes = scenario === 'two-globes' ? [globe, startSecondGlobe(app)] : [globe];
  showCursorReadout(globe, canvas);
  runScenario(globe, scenario);
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
  exposeTestHooks(globes, loop);
}
