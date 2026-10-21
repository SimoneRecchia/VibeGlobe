import { createControls } from '@vibeglobe/controls';
import { createGlobe, WGS84, type Globe, type GlobeOptions, type ViewInit } from '@vibeglobe/core';
import { xyzImagery } from '@vibeglobe/sources';
import { createWorkers } from '@vibeglobe/worker';
import { createRenderer, type BackendChoice, type DepthChoice } from '@vibeglobe/renderer';
import { startDragLoop, startFrameLoop, type FrameLoop } from './frame-loop.js';
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
const assets = params.get('assets');
const backend: BackendChoice = backendParam === 'webgpu' || backendParam === 'webgl2' ? backendParam : 'auto';
const depth: DepthChoice = params.get('depth') === 'fragment' ? 'fragment' : 'auto';

const DEG = Math.PI / 180;
/** A box around Italy, radians: the coverage of `?coverage=italy`. */
const ITALY = { westRad: 6 * DEG, southRad: 36 * DEG, eastRad: 19 * DEG, northRad: 47.5 * DEG };

/**
 * `?imagery=<pattern>` streams Web Mercator tiles of a fixture pattern (world, levels, border) from the playground's
 * fixture tile server (M3 plan §4.1); `&session=` names the server session that holds fault rules and the request log.
 */
function fixtureImagery(): Pick<GlobeOptions, 'imagery' | 'workers' | 'memory'> {
  const pattern = params.get('imagery');
  if (!pattern) return {};
  const session = params.get('session') ?? 'playground';
  // `?tileBase=` serves the tiles from another fixture server (for example `http://{s}:5177/` with
  // `&subdomains=localhost,127.0.0.1` for two hosts, F089, or the HTTP/2 one with `&multiplexed=1`, F096).
  const base = params.get('tileBase') ?? import.meta.env.BASE_URL;
  // `?ktx2=etc1s|uastc` serves KTX2 tiles with a full mip chain instead of PNG (F104).
  const ktx2 = params.get('ktx2');
  const extension = ktx2 === 'etc1s' || ktx2 === 'uastc' ? `${ktx2}.ktx2` : 'png';
  const url = `${base}fixture-tiles/${session}/${pattern}/mercator/{z}/{x}/{y}.${extension}`;
  // `?assets=<path>/` serves the engine's assets from another base URL: the worker program and the base image (F100).
  const workers = assets === null ? createWorkers() : createWorkers({ url: `${assets}vibeglobe-worker.js` });
  const number = (name: string): number | undefined => (params.has(name) ? Number(params.get(name)) : undefined);
  const timeoutMs = number('timeoutMs');
  const source = xyzImagery({
    id: `fixture-${pattern}`,
    url,
    minLevel: number('imageryMin') ?? 0,
    maxLevel: number('imageryMax') ?? 18,
    ...(params.has('subdomains') ? { subdomains: (params.get('subdomains') ?? '').split(',') } : {}),
    ...(params.has('perHost') ? { maxRequestsPerHost: Number(params.get('perHost')) } : {}),
    ...(params.has('multiplexed') ? { multiplexed: true } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutsMs: { firstByteMs: timeoutMs, totalMs: timeoutMs } }),
    // `?coverage=italy` limits the source to a box around Italy (F094).
    ...(params.get('coverage') === 'italy' ? { coverage: [ITALY] } : {}),
    ...(extension === 'png' ? {} : { decoder: 'ktx2' as const }),
  });
  // `?gpuBudgetMB=&ramBudgetMB=` set the cache budgets (F098).
  const megabytes = (name: string): number | undefined =>
    params.has(name) ? Math.round(Number(params.get(name)) * 1024 * 1024) : undefined;
  const gpuBudgetBytes = megabytes('gpuBudgetMB');
  const ramBudgetBytes = megabytes('ramBudgetMB');
  const memory = {
    ...(gpuBudgetBytes === undefined ? {} : { gpuBudgetBytes }),
    ...(ramBudgetBytes === undefined ? {} : { ramBudgetBytes }),
  };
  return { imagery: [source], workers, memory };
}

/** Creates one engine instance in a container with its own canvas. */
function startGlobe(
  container: HTMLElement,
  target: HTMLCanvasElement,
  view: ViewInit,
  choice: BackendChoice = backend,
): Globe {
  return createGlobe({
    container,
    // `?gpuTiming=1` measures GPU time per frame where timestamp queries exist (benchmark scenarios `drag-*`).
    renderer: createRenderer({
      backend: choice,
      depth,
      canvas: target,
      gpuTiming: params.has('gpuTiming'),
      // `?compressed=bc,etc2` limits the compressed families KTX2 tiles may use; `?compressed=` forces RGBA8 (F104).
      ...(params.has('compressed')
        ? { compressedTextures: (params.get('compressed') ?? '').split(',').filter(Boolean) }
        : {}),
    }),
    controls: createControls(),
    baseImageryUrl: `${assets ?? `${import.meta.env.BASE_URL}imagery/`}natural-earth-4096.jpg`,
    view,
    ...fixtureImagery(),
    // `?level=` sets the coarsest surface level, which sets how many tiles a view draws (benchmark scenarios `drag-*`).
    ...(params.has('level') ? { minSurfaceLevel: Number(params.get('level')) } : {}),
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

/**
 * Mounts another engine instance in a new element and returns it with a function that destroys it and removes the
 * element, as a single-page app does on navigation (leak suite, ADR 0010).
 */
function mountGlobe(
  canvas?: HTMLCanvasElement,
  choice?: BackendChoice,
): { globe: Globe; canvas: HTMLCanvasElement; unmount(): void } {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:0;top:0;width:320px;height:240px';
  const target = canvas ?? document.createElement('canvas');
  host.append(target);
  document.body.append(host);
  const globe = startGlobe(host, target, viewFromUrl(), choice);
  return {
    globe,
    canvas: target,
    unmount() {
      globe.destroy();
      host.remove();
    },
  };
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
  let surfaceInfo = '';
  // Read at start and again after a recovery, which may have switched the backend (KB-049).
  const readInfo = (): void => {
    const caps = globe.capabilities;
    if (!caps) return;
    pipelineCompiles = Number.NaN;
    info = [
      ['backend', `backend ${caps.backend}`],
      ['max-texture-size', `max texture ${caps.maxTextureSize}`],
      ['max-anisotropy', `anisotropy ${caps.maxAnisotropy}`],
      ['compressed-formats', `compressed ${caps.compressedTextureFormats.join(', ') || 'none'}`],
      ['device-memory', `memory ${caps.deviceMemoryGiB === undefined ? 'unknown' : `${caps.deviceMemoryGiB} GiB`}`],
      ['adapter', `adapter ${caps.adapter}`],
      ['depth', `depth ${caps.depthPath} ${caps.depthFormat}`],
    ];
  };
  void globe.ready.then(readInfo);
  globe.on('device-restored', readInfo);
  let lastRefreshMs = -Infinity;
  return startFrameLoop((stats, timestampMs) => {
    if (timestampMs - lastRefreshMs < OVERLAY_REFRESH_MS) return;
    lastRefreshMs = timestampMs;
    overlay.update({ frameTimeMs: stats.meanFrameTimeMs, framesPerSecond: stats.framesPerSecond });
    // Pipelines compiled after the warm-up stay 0 in normal use (ADR 0010 §4).
    const rendererStats = globe.rendererStats();
    const compiles = info.length > 0 ? rendererStats.pipelineCompiles : -1;
    // Draw calls and pipeline changes of the last frame (F103).
    const draws = `draw calls ${rendererStats.drawCalls} · pipeline switches ${rendererStats.pipelineSwitches}`;
    // The surface selection: drawn tiles and what culling skipped (F086, F087).
    const selection = globe.surfaceStats();
    const surface =
      `tiles ${selection.tiles} · level ≤ ${selection.maxLevel} · culled: frustum ${selection.culledByFrustum}, ` +
      `horizon ${selection.culledByHorizon} · imagery from ancestor ${selection.fromAncestor}, base ${selection.onBaseImage}` +
      // The largest projected texel of any drawn tile, which the selection keeps at or below 1.5 px (F081).
      ` · texel ≤ ${Math.max(0, ...globe.surfaceTiles().map((tile) => tile.texelErrorPx)).toFixed(2)} px`;
    // The imagery caches: RAM hits (F097) and memory against the budgets (F098).
    const imagery = globe.imageryStats();
    const mb = (bytes: number): string => (bytes / 1048576).toFixed(1);
    const cache = imagery
      ? `RAM hits ${imagery.ramHits} · GPU ${mb(imagery.gpuBytes)}/${mb(imagery.gpuBudgetBytes)} MB · RAM ` +
        `${mb(imagery.ramBytes)}/${mb(imagery.ramBudgetBytes)} MB · evicted ${imagery.evicted}`
      : '';
    if (compiles === pipelineCompiles && surface + cache + draws === surfaceInfo) return;
    pipelineCompiles = compiles;
    surfaceInfo = surface + cache + draws;
    overlay.setInfo([
      ...info,
      ['pipeline-compiles', `pipelines after warm-up ${compiles}`],
      ['draws', draws],
      ['surface', surface],
      ...(imagery ? ([['cache', cache]] as [string, string][]) : []),
    ]);
  });
}

const experiment = params.get('experiment') === 'offscreen' ? params.get('render') : null;

if (params.get('experiment') === 'gpu-probes') {
  // ADR 0004 and 0005's GPU readback probes, loaded on demand (`e2e/globe-gpu-probes.spec.ts`).
  const { runGpuProbesPage } = await import('./gpu-probes.js');
  await runGpuProbesPage(params, status);
} else if (app && canvas && experiment === 'worker') {
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
  const showBackend = (): void =>
    setStatus(`${globe.backend ?? ''} · WGS84, a = ${WGS84.semiMajorAxisMeters} m · Made with Natural Earth`);
  globe.on('device-restored', showBackend);
  globe.ready.then(showBackend, (error: unknown) =>
    setStatus(`The globe could not start: ${error instanceof Error ? error.message : String(error)}`),
  );
  let loop: FrameLoop | undefined;
  if (params.has('debug')) loop = await startDebugOverlay(globe, app);
  else if (scenario === 'frame-loop') loop = startFrameLoop(() => undefined);
  else if (scenario === 'drag') loop = startDragLoop(globe);
  exposeTestHooks(globes, loop, firstFrame, mountGlobe);
}
