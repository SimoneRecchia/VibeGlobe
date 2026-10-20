import { createControls } from '@vibeglobe/controls';
import { createGlobe, WGS84, type ViewInit } from '@vibeglobe/core';
import { createRenderer, type BackendChoice } from '@vibeglobe/renderer';
import { startFrameLoop } from './frame-loop.js';
import { exposeTestHooks } from './test-hooks.js';

const OVERLAY_REFRESH_MS = 250;

const params = new URLSearchParams(location.search);
const app = document.querySelector<HTMLDivElement>('#app');
const canvas = document.querySelector<HTMLCanvasElement>('#globe');
const status = document.querySelector<HTMLParagraphElement>('#status');

/** The initial view from the URL (`?lon=&lat=&zoom=&heading=&tilt=`), each optional. */
function viewFromUrl(): ViewInit {
  const read = (name: string): number | undefined => {
    const value = params.get(name);
    return value === null ? undefined : Number(value);
  };
  const view: Record<string, number> = {};
  for (const [param, field] of [
    ['lon', 'longitudeDeg'],
    ['lat', 'latitudeDeg'],
    ['zoom', 'zoom'],
    ['heading', 'headingDeg'],
    ['tilt', 'tiltDeg'],
  ] as const) {
    const value = read(param);
    if (value !== undefined) view[field] = value;
  }
  return view;
}

const backendParam = params.get('backend');
const backend: BackendChoice = backendParam === 'webgpu' || backendParam === 'webgl2' ? backendParam : 'auto';

if (app && canvas) {
  const globe = createGlobe({
    container: app,
    renderer: createRenderer({ backend, canvas }),
    controls: createControls(),
    baseImageryUrl: `${import.meta.env.BASE_URL}imagery/natural-earth-4096.jpg`,
    view: viewFromUrl(),
  });
  const setStatus = (text: string): void => {
    if (status) status.textContent = text;
  };
  setStatus(`Starting… Reference ellipsoid: WGS84, a = ${WGS84.semiMajorAxisMeters} m.`);
  globe.ready.then(
    () => setStatus(`${globe.backend ?? ''} · WGS84, a = ${WGS84.semiMajorAxisMeters} m · Made with Natural Earth`),
    (error: unknown) =>
      setStatus(`The globe could not start: ${error instanceof Error ? error.message : String(error)}`),
  );
  let loop = undefined;
  if (params.has('debug')) {
    // Loaded on demand so the overlay code is not part of the default page.
    const { createDebugOverlay } = await import('@vibeglobe/ui');
    const overlay = createDebugOverlay(app);
    let lastRefreshMs = -Infinity;
    loop = startFrameLoop((stats, timestampMs) => {
      if (timestampMs - lastRefreshMs < OVERLAY_REFRESH_MS) return;
      lastRefreshMs = timestampMs;
      overlay.update({ frameTimeMs: stats.meanFrameTimeMs, framesPerSecond: stats.framesPerSecond });
    });
  } else if (params.get('scenario') === 'frame-loop') {
    loop = startFrameLoop(() => undefined);
  }
  exposeTestHooks(globe, loop);
}
