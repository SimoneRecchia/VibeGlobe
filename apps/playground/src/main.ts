import { createControls } from '@vibeglobe/controls';
import {
  createGlobe,
  readGeoidFile,
  WGS84,
  type Globe,
  type GlobeOptions,
  type LogEntry,
  type ViewCurvesInit,
  type ViewInit,
  type WorkerEndpointFactory,
} from '@vibeglobe/core';
import { heightmapTerrain, quantizedMeshTerrain, xyzImagery } from '@vibeglobe/sources';
import { showCameraControls } from './camera-controls.js';
import { showViewModeControls } from './view-mode-controls.js';
import { createWorkers } from '@vibeglobe/worker';
import { createRenderer, type BackendChoice, type DepthChoice } from '@vibeglobe/renderer';
import { startDragLoop, startFrameLoop, type FrameLoop } from './frame-loop.js';
import { instrumentMainThread, startWorkerRendering } from './render-experiment/page.js';
import { runScenario } from './scenarios.js';
import { float32Terrain, rgb24Terrain } from './terrain-adapters.js';
import { exposeTestHooks } from './test-hooks.js';

const OVERLAY_REFRESH_MS = 250;
/** Engine log messages collected with `?logSink=1` (F120). */
const logEntries: LogEntry[] = [];

const params = new URLSearchParams(location.search);

/**
 * Terrain scenarios (M4): URL parameters each one sets unless the URL gives them, over the fixture server's analytic
 * terrain (a 4,000 m peak at 6.86° E, 45.83° N and a sharp 1,500 m ridge along 46.5° N from 7° to 10° E).
 */
const TERRAIN_SCENARIOS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // The peak and its valleys, tilted (F126, F134, F138, F146).
  'terrain-alps': { terrain: 'terrarium', imagery: 'world', lon: '6.86', lat: '45.7', zoom: '11', tilt: '60' },
  // One view per encoding (F127, F129, F130).
  'terrain-terrarium': {
    terrain: 'terrarium',
    imagery: 'world',
    lon: '6.7',
    lat: '45.6',
    zoom: '9.5',
    tilt: '45',
    heading: '30',
  },
  'terrain-rgb': {
    terrain: 'terrain-rgb',
    imagery: 'world',
    lon: '6.7',
    lat: '45.6',
    zoom: '9.5',
    tilt: '45',
    heading: '30',
  },
  // Farther out: quantized-mesh's level-zero error (65 samples per tile) refines about two levels deeper than 256 px
  // heightmaps, so the same view would stream about 230 tiles.
  'terrain-quantized-mesh': {
    terrain: 'quantized-mesh',
    imagery: 'world',
    lon: '6.7',
    lat: '45.6',
    zoom: '7.5',
    tilt: '30',
    heading: '30',
  },
  // Steep relief across tiles of different levels: the ridge seen along its length (F137).
  'terrain-crack-sweep': { terrain: 'terrain-rgb', imagery: 'world', lon: '8.5', lat: '46.42', zoom: '13', tilt: '70' },
  // The eye 2 m above the peak's steep flank (F136).
  'terrain-street-level': {
    terrain: 'terrarium',
    imagery: 'stripes',
    lon: '6.9',
    lat: '45.84',
    zoom: '22',
    tilt: '55',
    terrainClearance: '2',
  },
  // The peak 200 km away, from about 400 m up: its base lies behind the ellipsoid's horizon (about 70 km away), its
  // top about 8 px above it on a 480 × 360 canvas (F142).
  'terrain-horizon-peaks': {
    terrain: 'terrarium',
    imagery: 'world',
    lon: '6.86',
    lat: '44.03',
    zoom: '12',
    tilt: '87',
  },
  // Terrain to level 10, imagery to level 18 (F140).
  'independent-levels': {
    terrain: 'terrarium',
    terrainMax: '10',
    imagery: 'world',
    imageryMax: '18',
    // Over the fixture's ±300 m hills, below the eye: the view's distances match the imagery-only reference's.
    lon: '11',
    lat: '44.5',
    zoom: '17',
    tilt: '45',
  },
  // M5 phases: the whole globe (F151), a city on the flat 2D map (F153) and a city in Auto mode to zoom into (F154).
  'globe-world': { imagery: 'world', lon: '10', lat: '20', zoom: '1' },
  'map-2d-city': { imagery: 'world', lon: '12.5', lat: '41.9', zoom: '11' },
  'zoom-city-to-street': { imagery: 'world', lon: '12.5', lat: '41.9', zoom: '12' },
  // M5: the fixture cones at 100° E seen from the south, tilted, at ground zoom 14.2 (F157); the URL sets the latitude.
  'terrain-cones': { terrain: 'terrarium', imagery: 'smooth', lon: '100', lat: '0', zoom: '14.2', tilt: '83' },
  // The flat map in 2D just west of the antimeridian, for drags across it (F159).
  'map-2d-antimeridian': { imagery: 'smooth', lon: '179.2', lat: '20', zoom: '6.6', viewMode: '2d' },
  // A chosen 70° tilt looking north 4.5 km south of the fixture ridge (F165).
  'tilt-clamp-terrain': {
    terrain: 'terrarium',
    imagery: 'smooth',
    lon: '8.5',
    lat: '46.4595',
    zoom: '12.5',
    tilt: '70',
  },
};
for (const [name, value] of Object.entries(TERRAIN_SCENARIOS[params.get('scenario') ?? ''] ?? {}))
  if (!params.has(name)) params.set(name, value);
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
/** The coverage of `?terrainCoverage=alps`: east of 6.5° E, so its west edge crosses the peak's valleys (F139). */
const ALPS = { westRad: 6.5 * DEG, southRad: 43 * DEG, eastRad: 12 * DEG, northRad: 48 * DEG };

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
  // `?imageryTiling=geographic` serves the imagery in the geographic scheme (F141).
  const imageryTiling = params.get('imageryTiling') === 'geographic' ? 'geographic' : 'mercator';
  const url = `${base}fixture-tiles/${session}/${pattern}/${imageryTiling}/{z}/{x}/{y}.${extension}`;
  // `?assets=<path>/` serves the engine's assets from another base URL: the worker program and the base image (F100).
  const workers = assets === null ? createWorkers() : createWorkers({ url: `${assets}vibeglobe-worker.js` });
  const number = (name: string): number | undefined => (params.has(name) ? Number(params.get(name)) : undefined);
  const timeoutMs = number('timeoutMs');
  const source = xyzImagery({
    id: `fixture-${pattern}`,
    url,
    tiling: imageryTiling,
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

/**
 * `?terrain=terrarium|terrain-rgb` displaces the surface with the fixture server's analytic terrain (M4 plan §2) in
 * that encoding; `&terrainTiling=geographic` serves it in the geographic scheme, `&terrainMax=` limits its levels.
 */
function fixtureTerrain(): Pick<GlobeOptions, 'terrain' | 'workers'> {
  const encoding = params.get('terrain');
  const workers = (): WorkerEndpointFactory =>
    assets === null ? createWorkers() : createWorkers({ url: `${assets}vibeglobe-worker.js` });
  if (quantizedMesh) return { terrain: quantizedMesh, workers: workers() };
  // `?terrain=rgb24|float32`: the fixture terrain in two encodings the engine does not know, decoded by the test
  // adapters of `terrain-adapters.ts` (F132).
  if (encoding === 'rgb24' || encoding === 'float32') {
    const url = `${import.meta.env.BASE_URL}fixture-tiles/${params.get('session') ?? 'playground'}/terrain/mercator/{z}/{x}/{y}.${encoding === 'rgb24' ? 'rgb24' : 'f32'}`;
    const adapter = encoding === 'rgb24' ? rgb24Terrain : float32Terrain;
    return { terrain: adapter(`fixture-terrain-${encoding}`, url), workers: workers() };
  }
  if (encoding !== 'terrarium' && encoding !== 'terrain-rgb') return {};
  const session = params.get('session') ?? 'playground';
  const scheme = params.get('terrainTiling') === 'geographic' ? 'geographic' : 'mercator';
  // `&terrainDatum=geoid`: the same terrain served above the fixture geoid, with the geoid's grid file (F133).
  const path = geoid ? 'terrain-geoid' : 'terrain';
  const terrain = heightmapTerrain({
    id: `fixture-terrain-${encoding}`,
    url: `${import.meta.env.BASE_URL}fixture-tiles/${session}/${path}/${scheme}/{z}/{x}/{y}.${encoding}.png`,
    encoding,
    tiling: scheme,
    maxLevel: params.has('terrainMax') ? Number(params.get('terrainMax')) : 14,
    // `&terrainCoverage=alps` limits the terrain to a box whose west edge crosses the Alps views (F139).
    ...(params.get('terrainCoverage') === 'alps' ? { coverage: [ALPS] } : {}),
    ...(geoid ? { datum: { kind: 'geoid' as const, model: geoid } } : {}),
  });
  return { terrain, workers: workers() };
}

/** The fixture geoid for `?terrainDatum=geoid`, read before the globe starts. */
const geoid =
  params.get('terrainDatum') === 'geoid'
    ? readGeoidFile(await (await fetch(`${import.meta.env.BASE_URL}fixture-geoid.bin`)).arrayBuffer())
    : undefined;

/**
 * `?terrain=quantized-mesh` reads the fixture server's `layer.json` for the session (geographic by default,
 * `&terrainTiling=mercator`) before the globe starts (F127, F128).
 */
const quantizedMesh =
  params.get('terrain') === 'quantized-mesh'
    ? await quantizedMeshTerrain({
        id: 'fixture-terrain-quantized-mesh',
        url: `${import.meta.env.BASE_URL}fixture-tiles/${params.get('session') ?? 'playground'}/terrain/${
          params.get('terrainTiling') === 'mercator' ? 'mercator' : 'geographic'
        }/layer.json`,
      })
    : undefined;

/** The fixture imagery and terrain of the URL, sharing one worker pool. */
function fixtureLayers(): Pick<GlobeOptions, 'imagery' | 'terrain' | 'workers' | 'memory'> {
  const imagery = fixtureImagery();
  const terrain = fixtureTerrain();
  return { ...terrain, ...imagery };
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
    ...fixtureLayers(),
    // `?clockStepMs=` steps engine time by a fixed amount per drawn frame and `?fadeMs=` sets the imagery cross-fade
    // (scenario tests, F105; `fadeMs=0` is their injected pop).
    ...(params.has('clockStepMs') ? { manualClockStepMs: Number(params.get('clockStepMs')) } : {}),
    ...(params.has('fadeMs') ? { imageryFadeMs: Number(params.get('fadeMs')) } : {}),
    // `?logSink=1` collects the engine's log messages for the test hooks instead of the console (F120).
    ...(params.has('logSink') ? { logSink: (entry: LogEntry) => void logEntries.push(entry) } : {}),
    // `?terrainClearance=` sets how far above the terrain the eye stays (F146).
    ...(params.has('terrainClearance') ? { terrainClearanceMeters: Number(params.get('terrainClearance')) } : {}),
    // `?curves=` sets the Auto mode's zoom curves as JSON (F150).
    ...(params.has('curves') ? { viewCurves: JSON.parse(params.get('curves') ?? '{}') as ViewCurvesInit } : {}),
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
  const [{ createDebugOverlay }, { addTileViewToggle }] = await Promise.all([
    import('@vibeglobe/ui'),
    import('./tile-view.js'),
  ]);
  const overlay = createDebugOverlay(host);
  addTileViewToggle(globe, host, params.has('imagery') ? `fixture-${params.get('imagery')}` : undefined);
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
      ? `RAM hits ${imagery.ramHits} · misses ${imagery.ramMisses} · requests in flight ${imagery.loading} · ` +
        `GPU ${mb(imagery.gpuBytes)}/${mb(imagery.gpuBudgetBytes)} MB · RAM ` +
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
  showViewModeControls(globe, app, params.get('viewMode'));
  showCameraControls(globe, app);
  runScenario(globe, scenario);
  // `?layers=demo`: data layers drawn by the renderer (M10), loaded only when asked for.
  if (params.get('layers') === 'demo')
    void globe.ready.then(async () => (await import('./layers-demo.js')).showLayersDemo(globe));
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
  // `?hud=1` shows the performance HUD (F119).
  const { createHud } = await import('./hud.js');
  const hud = createHud(globe, app);
  if (params.has('hud')) hud(true);
  exposeTestHooks(globes, loop, firstFrame, mountGlobe, { showHud: hud, logEntries });
}
