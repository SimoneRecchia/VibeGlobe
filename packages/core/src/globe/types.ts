import type { ModelHandle, ModelOptions, ModelRenderer } from '../layers/models.js';
import type { LayerRenderTarget } from '../layers/layer-target.js';
import type { ImageryLayerInput, ImageryLayers } from '../imagery/imagery-stack.js';
import type { Credit } from '../imagery/credits.js';
import type { TerrainSource } from '../terrain/terrain-source.js';
import type { ElevationSample } from '../terrain/terrain-heights.js';
import type { AbortSignalLike } from './imagery-runtime.js';
import type { GlobeDiagnostics, LogLevel, LogSink } from '../diagnostics/observability.js';
import type { DecodedTile } from '../scheduler/types.js';
import type { WorkerEndpointFactory } from '../scheduler/worker-protocol.js';
import type { TileMeshData } from '../surface/surface-mesh.js';
import type { GlobeError } from './errors.js';
import type { MorphFrame } from '../view/morph.js';
import type { ViewCurvesInit } from '../view/curves.js';
import type { ViewMode, ViewPhase } from '../view/view-state.js';
import type { FrameCapture, RendererStats, ResourceCounts } from './renderer-stats.js';

export type { FrameCapture, RendererStats, ResourceCounts } from './renderer-stats.js';

/** A WGS84 geodetic position: degrees and meters above the ellipsoid, whatever the display projection. */
export interface GeoPosition {
  /** Longitude in degrees, east positive. */
  readonly longitudeDeg: number;
  /** Latitude in degrees, north positive. */
  readonly latitudeDeg: number;
  /** Height above the WGS84 ellipsoid in meters (0 when omitted). */
  readonly heightMeters?: number;
}

/** A point on the canvas in CSS pixels, origin at the top-left corner. */
export interface ScreenPoint {
  readonly xPx: number;
  readonly yPx: number;
}

/** Graphics backend names. */
export type BackendName = 'webgpu' | 'webgl2';

/**
 * How the renderer stores depth (ADR 0005): 'reversed-z' maps depth to [0, 1] in hardware (WebGPU, and WebGL2 with
 * `EXT_clip_control`); 'fragment' writes the same value from the fragment shader (WebGL2 without the extension).
 */
export type DepthPath = 'reversed-z' | 'fragment';

/** What the active graphics device offers (F056). */
export interface RendererCapabilities {
  readonly backend: BackendName;
  /** Largest 2D texture edge, in texels. */
  readonly maxTextureSize: number;
  /** Largest anisotropic filtering level. */
  readonly maxAnisotropy: number;
  /** Compressed texture families the device decodes (for example 'bc', 'etc2', 'astc'). */
  readonly compressedTextureFormats: readonly string[];
  /** Device memory hint in GiB (navigator.deviceMemory) when the browser exposes it. */
  readonly deviceMemoryGiB: number | undefined;
  /** Adapter or renderer description for diagnostics. */
  readonly adapter: string;
  /** The active depth path. */
  readonly depthPath: DepthPath;
  /** The scene depth format, named as in WebGPU ('depth32float' on every path, ADR 0005). */
  readonly depthFormat: string;
}

/** The view the renderer draws, in eye-relative ECEF (ADR 0004): float64, rounded to float32 at upload. */
export interface FrameView {
  /** The frame's globe-to-flat morph (ADR 0008): the renderer forms both endpoints of every vertex and mixes them. */
  readonly morph: MorphFrame;
  readonly view: Float64Array;
  readonly projection: Float64Array;
  readonly eyeEcef: Float64Array;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly pixelRatio: number;
}

/** A flat test quad drawn with the surface's precision path, for scenario tests of jitter and depth (F057, F058). */
export interface DebugShape {
  /** The four corners, in order around the quad. */
  readonly corners: readonly [GeoPosition, GeoPosition, GeoPosition, GeoPosition];
  /** Color, each channel 0–1. */
  readonly colorRgb: readonly [number, number, number];
  /** When set, a smooth checker-like pattern fixed to the ground with cells of this size (a sum of sines). */
  readonly checkerMeters?: number;
}

/** A debug quad ready for the renderer: float32 offsets from a float64 origin. */
export interface DebugMeshData {
  readonly originEcef: Float64Array;
  readonly positions: Float32Array;
  readonly colorRgb: readonly [number, number, number];
  readonly checkerMeters: number;
}

/** Browser services the engine needs, supplied by the renderer plug-in because core has no DOM (architecture §1). */
export interface RenderHost {
  /** Schedules `callback` for the next display frame; returns an id for {@link RenderHost.cancelFrame}. */
  requestFrame(callback: (timeMs: number) => void): number;
  cancelFrame(id: number): void;
  /** Monotonic milliseconds. */
  now(): number;
  /** Calls `callback` once after `delayMs` (`setTimeout`); returns a handle for {@link RenderHost.clearTimer}. */
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
  /** Calls `callback` when the container's CSS size or the device pixel ratio changes; returns an unsubscribe. */
  observeSize(callback: () => void): () => void;
  /**
   * Optional: called at the start of every frame to catch a size or pixel-ratio change the browser reported no event
   * for; it reports one through the `observeSize` callback. Runs every frame, so it must not allocate.
   */
  checkSize?(): void;
  /** Calls `callback` with false when the page is hidden and true when it is shown again; returns an unsubscribe. */
  observeVisibility(callback: (visible: boolean) => void): () => void;
  /** The size of the container's content box (without padding) in CSS pixels: the area the canvas fills. */
  containerSize(): { widthPx: number; heightPx: number };
  /** Device pixel ratio. */
  pixelRatio(): number;
  /**
   * Optional: calls `callback` now and on every change with whether the system asks for reduced motion (F214); returns
   * an unsubscribe. Without it the engine assumes full motion.
   */
  observeReducedMotion?(callback: (reduce: boolean) => void): () => void;
  /** Optional: shows the drawn view at `opacity` (0 to 1), for a reduced-motion flight's fade (F214). */
  setOpacity?(opacity: number): void;
  /**
   * Optional: shows the credits of the sources in view in a minimal attribution element of the container, required
   * ones always visible (F255); an empty list hides it.
   */
  showCredits?(credits: readonly Credit[]): void;
}

/** Callbacks a renderer uses to report device events to the engine. */
export interface RendererEvents {
  deviceLost(reason: string): void;
  deviceRestored(): void;
  backendFallback(reason: string): void;
  failed(error: GlobeError): void;
}

/**
 * The surface tiles a frame draws (M3 plan §2.2), as parallel typed arrays reused every frame: draw `i` is the mesh
 * `meshKeys[i]` textured by `textures[i]` (a handle from {@link RendererBackend.uploadTexture}, or -1 for the world
 * base image) through the transform `uvTransforms[4i..4i+3]` = (scale u, scale v, offset u, offset v) from the tile's
 * own coordinates into the texture's. `geographic[i]` is 1 when the texture's rows are linear in latitude (the tile's
 * geographic v), 0 when they are in the tile's own scheme.
 */
/**
 * One layer's choice for every draw of a frame (ADR 0006 §4): the texture each draw shows, with its UV transform and
 * choice of v, and the one it fades from.
 */
export interface TileDrawLayer {
  readonly textures: Int32Array;
  /** Scale u, scale v, offset u, offset v from tile coordinates into the texture's, four per draw. */
  readonly uvTransforms: Float32Array;
  /** 1 where the texture's rows are linear in latitude, 0 where they follow the tile's own rows. */
  readonly geographic: Uint8Array;
  /** What each draw cross-fades from (F105, F138): like `textures`, `uvTransforms` and `geographic`. */
  readonly fromTextures: Int32Array;
  readonly fromUvTransforms: Float32Array;
  readonly fromGeographic: Uint8Array;
  /** Each draw's fade progress: 0 shows only the `from` data, 1 only its own. */
  readonly fades: Float32Array;
  /**
   * Meters to lower each draw's skirts by beyond its mesh's own depth (terrain only, 0 otherwise): a tile showing
   * terrain coarser than its level's may differ from its neighbors by that terrain's error.
   */
  readonly skirtMeters: Float32Array;
}

/**
 * An overlay slot of every draw (F244, F246): imagery above the draw's own, shown with an opacity and a blend mode.
 * `opacities[i]` 0 means draw `i` shows nothing in this slot.
 */
export interface TileDrawOverlay {
  readonly textures: Int32Array;
  readonly uvTransforms: Float32Array;
  readonly geographic: Uint8Array;
  readonly opacities: Float32Array;
  /** 0 normal, 1 multiply, 2 screen (`BLEND_CODES`). */
  readonly blends: Uint8Array;
}

/** The surface tiles a frame draws, with their imagery (the list's own layer) and their terrain heights. */
export interface TileDrawList extends TileDrawLayer {
  readonly count: number;
  readonly meshKeys: Float64Array;
  /**
   * Terrain heights (M4, ADR 0006 §5): height-grid textures by handle, {@link NO_TERRAIN} where a draw shows the
   * ellipsoid (no terrain source, or none resident yet).
   */
  readonly terrain: TileDrawLayer;
  /** Imagery shown above the draw's own, bottom first, in at most two slots (ADR 0038). */
  readonly overlays: readonly TileDrawOverlay[];
}

/** The terrain handle of a draw without terrain: heights are 0 on the ellipsoid. */
export const NO_TERRAIN = -1;

/** The engine's renderer interface; three.js stays behind it (ADR 0010). */
export interface RendererBackend {
  readonly capabilities: RendererCapabilities;
  readonly host: RenderHost;
  /** The element that receives input (the canvas). */
  readonly inputElement: unknown;
  /** Draws data layers (ADR 0037); absent in renderers that draw none. */
  readonly layers?: LayerRenderTarget;
  /** Optional: glTF models (F361, ADR 0037). */
  readonly models?: ModelRenderer;
  /** Uploads a surface tile mesh; returns false while the renderer cannot accept it. */
  addMesh(mesh: TileMeshData): void;
  removeMesh(key: number): void;
  /** Loads the pinned base imagery (an equirectangular world image); resolves when it is on the GPU. */
  setBaseImagery(url: string): Promise<void>;
  /**
   * Creates or replaces the GPU texture of an imagery tile under `handle` (a small integer the engine allocates) and
   * uploads it now, so no later frame waits for it (M3 plan §3). The renderer keeps the image to restore the texture
   * after a device loss.
   */
  uploadTexture(handle: number, tile: DecodedTile): void;
  /** Releases the texture under `handle`; nothing happens for an unknown handle. */
  releaseTexture(handle: number): void;
  /** Replaces the debug quads. */
  setDebugMeshes(meshes: readonly DebugMeshData[]): void;
  /** Cumulative counters. */
  stats(): RendererStats;
  /** Draws the listed surface tiles; returns false when nothing was drawn (while recovering or after giving up). */
  render(view: FrameView, draws: TileDrawList): boolean;
  resize(widthPx: number, heightPx: number, pixelRatio: number): void;
  resourceCounts(): ResourceCounts;
  /** Test hook: forces a device or context loss. */
  simulateDeviceLoss(): void;
  /** Test hook: the pixels of the frame just drawn, read in the same task (ADR 0012, Capture). */
  capture(): Promise<FrameCapture>;
  destroy(): void;
}

/** Creates the renderer for a container. Rejects with a GlobeError (code 'unsupported-device') when no backend works. */
export type RendererFactory = (container: unknown, events: RendererEvents) => Promise<RendererBackend>;

/** Intents an input plug-in sends to the engine (ADR 0009). */
export interface NavigationApi {
  /** Starts a pan: returns the geodetic point under the pixel, or undefined when the pixel is off the globe. */
  grab(point: ScreenPoint): GeoPosition | undefined;
  /** Moves the camera so the grabbed position lies under `point`. */
  dragTo(anchor: GeoPosition, point: ScreenPoint): void;
  /** Zooms by `deltaZoom` levels keeping the position under `point` fixed. */
  zoomAt(point: ScreenPoint, deltaZoom: number): void;
  /**
   * Asks for a frame, at whose start the engine calls the controls' {@link Controls.update} (ADR 0009 §3–4); a request
   * made inside `update` asks for the next frame.
   */
  requestUpdate(): void;
  /**
   * Turns the camera about the screen-center target by `deltaHeadingDeg` and tilts it by `deltaTiltDeg` (the new values
   * become the chosen ones, the tilt within 0–90° and the constraints); allocation-free (F182–F185).
   */
  orbit(deltaHeadingDeg: number, deltaTiltDeg: number): void;
  /**
   * True while the controls apply their release inertia: the camera changes made meanwhile are announced with the
   * cause 'inertia' instead of 'user' (F200). The controls set it around their inertia step.
   */
  coasting: boolean;
  /** The engine clock's time, milliseconds: inertia and held keys run on it (F179, F181). */
  readonly timeMs: number;
  /** The applied heading and tilt, degrees. */
  readonly headingDeg: number;
  readonly tiltDeg: number;
}

/** An input plug-in instance. */
export interface Controls {
  /**
   * Called at the start of every frame, before the camera is updated: turns the input recorded since the last frame
   * into navigation intents, so DOM handlers do no camera math (ADR 0009 §3–4). Runs every frame, so it must not
   * allocate when nothing is pending.
   */
  update?(): void;
  /** Optional: an API movement (`flyTo`, `easeTo`, …) starts: inertia, smoothed zooms and held keys stop (F202). */
  interrupt?(): void;
  destroy(): void;
}

/**
 * Creates input handling on the renderer's input element. A factory with `connect` is given the globe once it is
 * attached (the home and view-mode keys use it).
 */
export type ControlsFactory = ((element: unknown, navigation: NavigationApi) => Controls) & {
  connect?(globe: Globe): void;
};

/** The camera as the public API reports it: applied values, WGS84 degrees and meters. */
export interface CameraState {
  readonly longitudeDeg: number;
  readonly latitudeDeg: number;
  /** Web Mercator zoom, continuous. */
  readonly zoom: number;
  /** Eye height above the ellipsoid. */
  readonly altitudeMeters: number;
  readonly headingDeg: number;
  readonly tiltDeg: number;
  /** Roll about the viewing direction (0 for navigation). */
  readonly rollDeg: number;
  /** Distance from the eye to the target. */
  readonly rangeMeters: number;
  /** The eye's own position (the fields above place the target it looks at). */
  readonly eyeLongitudeDeg: number;
  readonly eyeLatitudeDeg: number;
  /**
   * Height above the ellipsoid of the surface the last frame showed under the eye: the terrain as drawn, its morph
   * included (F146, F147); 0 without terrain. `altitudeMeters` minus this is the eye's height above the ground.
   */
  readonly groundHeightMeters: number;
  /** The view mode: the zoom curves drive the tilt ('auto'), it stays 0° ('2d'), or the user chose it ('manual'). */
  readonly viewMode: ViewMode;
  /**
   * The tilt and heading the user chose (F164). `tiltDeg` and `headingDeg` are the applied values: a temporary clamp
   * (terrain, empty sky; F165, F166) or the Auto curve may lower the tilt, never the choice.
   */
  readonly chosenTiltDeg: number;
  readonly chosenHeadingDeg: number;
  /** The globe-to-flat morph factor the last frame drew: 0 the globe, 1 the flat map (ADR 0008). */
  readonly morphFactor: number;
  /** The share of terrain relief the last frame drew: 0 flat, 1 full height. */
  readonly reliefFactor: number;
  /** The phase of the last frame (`PLAN.md`, Map experience). */
  readonly phase: ViewPhase;
}

/** Initial camera. A tilt chooses it: the view mode becomes manual (ADR 0034). */
export interface ViewInit {
  readonly longitudeDeg?: number;
  readonly latitudeDeg?: number;
  readonly zoom?: number;
  readonly headingDeg?: number;
  readonly tiltDeg?: number;
}

/** Options of {@link createGlobe}. */
export interface GlobeOptions {
  /** The element the globe fills (an HTMLElement in browsers). */
  readonly container: unknown;
  readonly renderer: RendererFactory;
  readonly controls?: ControlsFactory;
  /** URL of the pinned base imagery: an equirectangular image of the whole world. */
  readonly baseImageryUrl: string;
  readonly view?: ViewInit;
  /** Camera constraints held for every input and movement (F209–F211); see {@link Globe.setConstraints}. */
  readonly constraints?: CameraConstraints;
  /** The project's home view (F194), which {@link Globe.goHome} flies to; by default the start view. */
  readonly home?: HomeView;
  /**
   * The zoom curves of the Auto view mode (F150): the globe-to-flat morph, the relief and the automatic tilt, each over
   * a band of ground zoom; fields not given keep `DEFAULT_VIEW_CURVES`. Invalid curves throw 'invalid-option'.
   */
  readonly viewCurves?: ViewCurvesInit;
  /** Multiplies the device pixel ratio (default 1). */
  readonly resolutionScale?: number;
  /** Largest projected geometric error, in CSS pixels (default 1). */
  readonly maxScreenErrorPx?: number;
  /**
   * Coarsest surface level drawn, an integer from 2 (the default) to 8: every visible surface tile is at least this
   * fine. Raising it costs draws and buys nothing visible in M2; benchmarks use it to set the tile count.
   */
  readonly minSurfaceLevel?: number;
  /**
   * Test mode (ADR 0012): engine time advances by exactly this many milliseconds per drawn frame, whatever the display
   * does, so animations and fades are reproducible frame by frame. Unset, it follows the display (each step at most
   * 100 ms).
   */
  readonly manualClockStepMs?: number;
  /**
   * Duration of the cross-fade when a surface tile's imagery changes, in milliseconds of engine time (F105): 250 by
   * default; 0 switches at once (a test's injected pop).
   */
  readonly imageryFadeMs?: number;
  /** The quietest messages the engine logs (F120): 'debug', 'info', 'warn' (default), 'error' or 'silent'. */
  readonly logLevel?: LogLevel;
  /** Receives the engine's log messages instead of the console (F120). */
  readonly logSink?: LogSink;
  /**
   * Tiled imagery layers, bottom first (M3, ADR 0038): each surface tile shows the topmost opaque layer that has a tile
   * for it (else the world base image), with up to two translucent or blended layers above it. A layer is a source, or
   * a chain of sources with an opacity, a visibility and a blend mode (`ImageryLayerOptions`). Tiles are fetched,
   * decoded in workers and uploaded as the view needs them.
   */
  readonly imagery?: readonly ImageryLayerInput[];
  /**
   * Ids of sources whose credits the attribution element and `Globe.credits()` leave out (F255). A credit the
   * source's provider requires stays, and a warning names the source.
   */
  readonly hiddenCredits?: readonly string[];
  /**
   * A terrain source (M4): the surface is displaced to its heights, decoded in workers; without one the surface is
   * the WGS84 ellipsoid. Where the source has no data the surface stays on the ellipsoid (ADR 0027).
   */
  readonly terrain?: TerrainSource;
  /**
   * How far above the displayed terrain the eye always stays, meters (F146; default 10): zooming, panning, tilting or
   * finer terrain arriving never takes the camera into the surface. Finer terrain lifts it as the surface morphs
   * (F147).
   */
  readonly terrainClearanceMeters?: number;
  /** The worker pool's endpoints, `createWorkers()` from `@vibeglobe/worker`; required with `imagery` or `terrain`. */
  readonly workers?: WorkerEndpointFactory;
  /** Memory budgets of the imagery caches (ADR 0007). */
  readonly memory?: MemoryOptions;
}

/** Budgets of the tile caches; usage never exceeds them (F098). */
export interface MemoryOptions {
  /** GPU memory for imagery textures, mip chains included (default 512 MiB); 1/8 of it holds the pinned base. */
  readonly gpuBudgetBytes?: number;
  /** RAM for encoded tile bytes, reused without a new request (default 256 MiB, F097). */
  readonly ramBudgetBytes?: number;
}

/** Counters of the terrain streaming of one engine instance (`Globe.terrainStats()`, F134). */
export interface TerrainStats {
  /** Tiles waiting for a request slot, in flight, being decoded, on the GPU, failed, without data. */
  readonly queued: number;
  readonly loading: number;
  readonly decoding: number;
  readonly ready: number;
  readonly failed: number;
  readonly noData: number;
  /** Requests started so far. */
  readonly requested: number;
  /** Height uploads so far, the time and bytes the last frame spent uploading, and the decoded tiles still waiting. */
  readonly uploads: number;
  readonly uploadMsLastFrame: number;
  readonly uploadBytesLastFrame: number;
  readonly uploadsPending: number;
  /** The bytes terrain may upload in one frame (ADR 0007's upload budget). */
  readonly uploadBudgetBytes: number;
  /** Main-thread time the last frame spent on terrain: tiles wanted, morphs, elevation queries, requests, uploads. */
  readonly msLastFrame: number;
}

/** Counters of the imagery streaming of one engine instance (`Globe.imageryStats()`). */
export interface ImageryStats {
  /** Tiles waiting for a request slot, in flight, being decoded, on the GPU, failed, without data. */
  readonly queued: number;
  readonly loading: number;
  readonly decoding: number;
  readonly ready: number;
  readonly failed: number;
  readonly noData: number;
  /** Requests started so far. */
  readonly requested: number;
  /** Texture uploads so far, and the time and bytes the last frame spent uploading (F101, F102). */
  readonly uploads: number;
  readonly uploadMsLastFrame: number;
  readonly uploadBytesLastFrame: number;
  /** Decoded tiles still waiting for their upload after the last frame. */
  readonly uploadsPending: number;
  /** Pinned base tiles resident (or without data) and in all (F084). */
  readonly pinnedSettled: number;
  readonly pinnedTotal: number;
  /** GPU and RAM usage and budgets, in bytes (F098). */
  readonly gpuBytes: number;
  readonly gpuBudgetBytes: number;
  readonly ramBytes: number;
  readonly ramBudgetBytes: number;
  /** Tiles found and not found in the RAM tier (F097). */
  readonly ramHits: number;
  readonly ramMisses: number;
  /** GPU evictions, and uploads refused because nothing could be evicted. */
  readonly evicted: number;
  readonly refused: number;
}

/** Events and their payloads. */
export interface GlobeEvents {
  /** The first complete frame was drawn. */
  ready: { readonly backend: BackendName };
  /** A frame was drawn. The payload object is reused: read it inside the handler, do not keep it. */
  frame: { readonly frameNumber: number; readonly tiles: number };
  /** Rendering stopped because nothing changes. The payload object is reused: read it inside the handler. */
  idle: { readonly frameNumber: number };
  /** The camera moved, once per drawn frame. The payload object is reused: read it inside the handler, do not keep it. */
  'camera-change': CameraState;
  'device-lost': { readonly reason: string };
  /**
   * The renderer was recreated after a device or context loss. It may have replaced its canvas with a new one carrying
   * the same id, class and ARIA attributes: listen for pointer events on the container, not on the canvas.
   */
  'device-restored': Record<string, never>;
  /** WebGPU could not be used and WebGL2 took over; the canvas may have been replaced, as for `device-restored`. */
  'backend-fallback': { readonly reason: string };
  /** An imagery tile failed for good; its area keeps showing an ancestor (F112). */
  'tile-error': TileErrorEvent;
  /** The credits of the sources in view changed (F254): the new list, as {@link Globe.credits} returns it. */
  'credits-change': { readonly credits: readonly Credit[] };
  /** The view mode changed: through {@link Globe.setViewMode}, or to 'manual' when a view chose a tilt (F163). */
  'view-mode-change': { readonly mode: ViewMode };
  /** A camera movement began (F200, ADR 0036). */
  movestart: MoveEvent;
  /** The camera moved in a movement, at most once per drawn frame. The payload object is reused. */
  move: MoveEvent;
  /** A camera movement ended, with how. */
  moveend: MoveEndEvent;
  /** A tour reached a waypoint (F199): its index in the tour. */
  'tour-waypoint': { readonly index: number };
  error: GlobeError;
}

/** What moved the camera (F200): a movement call, the user's input through the controls, or the controls' inertia. */
export type MoveCause = 'api' | 'user' | 'inertia';

/** How a movement ended (ADR 0036): it reached its target, a newer movement or user input took over, or it was cancelled. */
export type MoveOutcome = 'completed' | 'interrupted' | 'cancelled';

/** The payload of `movestart` and `move`. */
export interface MoveEvent {
  readonly cause: MoveCause;
}

/** The payload of `moveend`. */
export interface MoveEndEvent extends MoveEvent {
  readonly outcome: MoveOutcome;
}

/**
 * A running camera movement (ADR 0036): a promise of its outcome, which never rejects once the movement started, and
 * a way to stop it where it is.
 */
export interface CameraMovement extends Promise<MoveOutcome> {
  /** Stops the movement where the last frame left it; the promise settles as 'cancelled'. */
  cancel(): void;
}

/** Limits on the camera (F209–F211): zoom range, maximum tilt, and bounds for the view's center. */
export interface CameraConstraints {
  readonly minZoom?: number;
  readonly maxZoom?: number;
  readonly maxTiltDeg?: number;
  readonly bounds?: GeoBounds;
}

/** A home view (F194): a view, and optionally the view mode to set on the way. */
export interface HomeView extends ViewInit {
  readonly viewMode?: '2d' | '3d' | 'auto';
}

/** A place an application's geocoder found (F208). */
export interface GeocoderResult {
  /** What a result list shows. */
  readonly label: string;
  readonly longitudeDeg: number;
  readonly latitudeDeg: number;
  /** The zoom to show it at; a search box picks one when omitted and no bounds are given. */
  readonly zoom?: number;
  /** The area of the place: a search box then fits it to the view. */
  readonly bounds?: GeoBounds;
}

/**
 * A search provider the application supplies (F208): the engine and its packages bundle none and make no geocoding
 * request without one. `search` resolves the places matching `query`, empty when none; `signal` aborts a query the
 * user typed past.
 */
export interface Geocoder {
  search(
    query: string,
    options: { readonly signal: AbortSignalLike; readonly language: string },
  ): Promise<readonly GeocoderResult[]>;
}

/** A geographic rectangle in degrees; `eastDeg` below `westDeg` crosses the antimeridian. */
export interface GeoBounds {
  readonly westDeg: number;
  readonly southDeg: number;
  readonly eastDeg: number;
  readonly northDeg: number;
}

/** One stop of a tour (F199): where to go, how (a flight by default), how long the leg takes and how long to stay. */
export interface TourWaypoint {
  readonly target: ViewInit;
  readonly movement?: 'fly' | 'ease' | 'jump';
  readonly durationMs?: number;
  readonly dwellMs?: number;
}

/** Options of {@link Globe.easeTo} and {@link Globe.flyTo}. */
export interface MovementOptions {
  /** The movement's duration, milliseconds (0 or more); by default 1 s for an ease and, for a flight, the path's length. */
  readonly durationMs?: number;
  /** Cancels the movement when aborted, as {@link CameraMovement.cancel} does. */
  readonly signal?: AbortSignalLike;
  /** Flights without a duration: path units per second (default 1.2, more than 0; F195). */
  readonly speed?: number;
  /** Flights: van Wijk and Nuij's ρ, how high the flight rises (default 1.42, more than 0; F195). */
  readonly curve?: number;
  /** The timing curve: 'ease-in-out' (default), 'linear', or a function on [0, 1] with f(0) = 0 and f(1) = 1. */
  readonly easing?: 'ease-in-out' | 'linear' | ((t: number) => number);
}

/**
 * Why a tile failed for good: `corrupt` bytes that do not decode, `failed` after its retries ran out, or
 * `unsupported` data the engine or device cannot use (for example KTX2 without a usable transcoder, ADR 0020).
 */
/** Why a tile failed for good: 'cors' when its server sends no CORS headers (F251). */
export type TileErrorReason = 'corrupt' | 'failed' | 'unsupported' | 'cors';

/** A tile that failed for good. */
export interface TileErrorEvent {
  readonly sourceId: string;
  readonly level: number;
  readonly x: number;
  readonly y: number;
  readonly reason: TileErrorReason;
}

/** A surface tile of the last drawn frame, for diagnostics (ADR 0006 §1: a Web Mercator root and two polar caps). */
export interface SurfaceTileInfo {
  readonly root: 'mercator' | 'north-cap' | 'south-cap';
  readonly level: number;
  readonly x: number;
  readonly y: number;
  readonly westDeg: number;
  readonly southDeg: number;
  readonly eastDeg: number;
  readonly northDeg: number;
  /** The projected chord sag of the tile's mesh, in CSS pixels, for the current camera. */
  readonly geometricErrorPx: number;
  /** The projected size of one texel of the finest imagery layer, in CSS pixels (0 without imagery, F081). */
  readonly texelErrorPx: number;
  /** The imagery level the tile shows, an ancestor's while its own is not loaded (F083); null for the base image. */
  readonly imageryLevel: number | null;
  /** The terrain level the tile shows, an ancestor's while its own loads (F126, F139); null without terrain. */
  readonly terrainLevel: number | null;
  /** The projected error of the terrain the tile's level shows, in CSS pixels, as the selection measures it (F126). */
  readonly terrainErrorPx: number;
}

/** Counters of a frame's surface selection. */
export interface SurfaceStats {
  /** Tiles drawn. */
  readonly tiles: number;
  /** Deepest level drawn. */
  readonly maxLevel: number;
  /** Tiles skipped as outside the view frustum (F086). */
  readonly culledByFrustum: number;
  /** Tiles skipped as beyond the horizon (F087). */
  readonly culledByHorizon: number;
  /** Tiles showing an ancestor's imagery while their own tile loads or has failed (F083). */
  readonly fromAncestor: number;
  /** Tiles showing the world base image: no imagery layer has a tile for them yet. */
  readonly onBaseImage: number;
}

/** A globe engine instance. */
export interface Globe {
  /** Resolves after the first complete frame; rejects with a GlobeError when the engine cannot start. */
  readonly ready: Promise<void>;
  /** Log level, phase timing and event traces (F118–F121, docs/guides/debugging.md). */
  readonly diagnostics: GlobeDiagnostics;
  /** Active backend, available after `ready`. */
  readonly backend: BackendName | undefined;
  /** Device capabilities, available after `ready`. */
  readonly capabilities: RendererCapabilities | undefined;
  /**
   * Current camera, applied values. While a view with a zoom waits for a viewport (before the renderer gives it a size,
   * or a `jumpTo` with a zoom while the container is hidden or collapsed), the requested view, with `rangeMeters` and
   * `altitudeMeters` NaN, applied when the viewport has a size. A collapsed container otherwise keeps the camera as it
   * was, with its range.
   */
  readonly camera: CameraState;
  /** Engine time in milliseconds, which animations and fades run on (ADR 0009): display steps clamped to 100 ms. */
  readonly timeMs: number;
  /** Frames drawn since creation. */
  readonly frameNumber: number;
  /** Input intents, used by the controls plug-in and available to applications. */
  readonly navigation: NavigationApi;
  /**
   * Moves the camera in one frame (before `ready`, the start view becomes this one), with `movestart`, `move` and
   * `moveend` (F197); the returned movement has already settled as 'completed', like the other movements' (F200).
   * Invalid input throws a GlobeError and leaves the camera unchanged.
   */
  jumpTo(target: ViewInit): CameraMovement;
  /**
   * Moves the camera to `target` with eased interpolation of center, zoom, heading and tilt, the shorter way round
   * (F198). Fields not given keep their values: the chosen tilt, heading and view mode stay unless given (F201).
   * Invalid input rejects with a GlobeError and moves nothing.
   */
  easeTo(target: ViewInit, options?: MovementOptions): CameraMovement;
  /**
   * Flies the camera to `target` along van Wijk and Nuij's zoom-out and zoom-in path (F195, F196), ending exactly
   * there. Fields not given keep their values, as for {@link easeTo}.
   */
  flyTo(target: ViewInit, options?: MovementOptions): CameraMovement;
  /**
   * Flies (or eases, with `movement: 'ease'`) to the view that shows `bounds` inside the viewport minus `paddingPx`
   * (default 0) on every side, keeping the heading and the view mode's tilt (F176). Positions in `include`, heights
   * included, must show inside it too (objects above the ground, F387).
   */
  fitBounds(
    bounds: GeoBounds,
    options?: MovementOptions & {
      readonly paddingPx?: number;
      readonly movement?: 'fly' | 'ease';
      readonly include?: readonly GeoPosition[];
    },
  ): CameraMovement;
  /**
   * Plays the waypoints in order, each with its movement, duration and dwell time, announcing each with a
   * `tour-waypoint` event (F199). It settles as completed at the end, interrupted when user input or another movement
   * takes over, and cancelled through cancel() or the signal.
   */
  tour(waypoints: readonly TourWaypoint[], options?: { readonly signal?: AbortSignalLike }): CameraMovement;
  /** Turns the view to `headingDeg` along the shorter arc, keeping center and tilt (F191: 0 north, 90 east…). */
  rotateTo(headingDeg: number, options?: MovementOptions): CameraMovement;
  /**
   * The tilt control (F188): eases the view to `tiltDeg`, keeping center, zoom and heading. The tilt becomes the chosen
   * one (manual mode, also from 2D or Auto, as tilting by hand does: ADR 0034) and never exceeds the maximum tilt.
   */
  tiltTo(tiltDeg: number, options?: MovementOptions): CameraMovement;
  /** Replaces the camera constraints (F209–F211); invalid ones throw a GlobeError and change nothing. */
  setConstraints(constraints: CameraConstraints): void;
  /** Flies out to the whole globe centered on the current location (F193). */
  resetToGlobe(options?: MovementOptions): CameraMovement;
  /** Flies to the home view (F194), setting its view mode first when it has one. */
  goHome(options?: MovementOptions): CameraMovement;
  /**
   * Orbits the camera about `center` (by default the target) at `degreesPerSecond` (default 10), keeping the center
   * fixed on screen, until cancelled, interrupted by input or replaced by another movement (F192).
   */
  orbit(options?: {
    readonly center?: GeoPosition;
    readonly degreesPerSecond?: number;
    readonly signal?: AbortSignalLike;
  }): CameraMovement;
  /** The current view mode (F161–F163). */
  readonly viewMode: ViewMode;
  /**
   * Whether the system asks for reduced motion (F214), followed at runtime: flights then fade to their target in
   * 300 ms instead of traversing the path, and input should keep inertia and other large animations to a minimum.
   */
  readonly reducedMotion: boolean;
  /**
   * The 2D / 3D / Auto toggle (F163): '2d' keeps the tilt at 0° at every zoom while the globe still flattens, '3d'
   * chooses the default tilt (manual mode), 'auto' restores the zoom-driven curves. Anything else throws a GlobeError
   * ('invalid-option').
   */
  setViewMode(mode: '2d' | '3d' | 'auto'): void;
  /**
   * Replaces the zoom curves (F150): fields not given keep their defaults; the view eases to the new curves without a
   * jump. Invalid curves throw a GlobeError ('invalid-option') and change nothing.
   */
  setViewCurves(curves: ViewCurvesInit): void;
  /**
   * The WGS84 position shown at a screen point, or undefined off the globe or before the viewport has a size. Over
   * terrain it is the point of the terrain drawn there, with its height from the terrain in memory (F383); without
   * terrain, the ellipsoid's, height 0. A point without finite `xPx` and `yPx` throws a GlobeError ('invalid-coordinate').
   */
  screenToGeo(point: ScreenPoint): GeoPosition | undefined;
  /**
   * The screen point showing a WGS84 position, or undefined when it is behind the camera or before the viewport has a
   * size. A position with non-finite values or a latitude outside ±90° throws a GlobeError ('invalid-coordinate').
   */
  geoToScreen(position: GeoPosition): ScreenPoint | undefined;
  /** Subscribes to an event; returns an unsubscribe function. */
  on<E extends keyof GlobeEvents>(event: E, handler: (payload: GlobeEvents[E]) => void): () => void;
  /** Changes the resolution scale (a multiplier of the device pixel ratio, 0.1–4) and redraws. */
  setResolutionScale(scale: number): void;
  /** Requests a frame, for example after an external change. */
  requestRender(): void;
  /** GPU resource counters. */
  resourceCounts(): ResourceCounts;
  /** Renderer counters: draw calls, triangles, texture uploads, automatic matrix updates and pipeline compiles. */
  rendererStats(): RendererStats;
  /** Diagnostics: the surface tiles the last drawn frame selected (debug overlay, F086, F087, F116). */
  surfaceTiles(): SurfaceTileInfo[];
  /** Diagnostics: counters of the last drawn frame's surface selection. */
  surfaceStats(): SurfaceStats;
  /** Counters of the imagery streaming; undefined without imagery layers or before the renderer starts. */
  imageryStats(): ImageryStats | undefined;
  /** Counters of the terrain streaming; undefined without terrain or before the renderer starts (F134). */
  terrainStats(): TerrainStats | undefined;
  /**
   * The terrain height at a position from the terrain already in memory, with the level it came from (F144): the
   * deepest resident tile, interpolated as the surface shows it. Where no terrain is resident or covers the position,
   * the ellipsoid's height 0 with `noData` set. Writes into `out` when given, so a caller can query without
   * allocating. Throws a GlobeError ('invalid-coordinate') for an invalid position.
   */
  elevationAt(position: GeoPosition, out?: ElevationSample): ElevationSample;
  /**
   * The terrain height at a position from the finest terrain the source delivers there, loading it first (F145).
   * Rejects with a GlobeError: 'resource-failed' when that tile fails for good, 'aborted' when `signal` aborts,
   * 'destroyed' when the globe is destroyed first. Without terrain it resolves with the ellipsoid's height 0, `noData`.
   */
  elevationAtAsync(position: GeoPosition, options?: { signal?: AbortSignalLike }): Promise<ElevationSample>;
  /** Draws test quads (scenario tests of jitter and depth); an empty list removes them. */
  setDebugShapes(shapes: readonly DebugShape[]): void;
  /**
   * Where data layers draw (ADR 0037): the renderer's batches, each change shown on the next frame. Undefined until the
   * renderer has started (after `ready`) or when it draws no layers.
   */
  layerTarget(): LayerRenderTarget | undefined;
  /** The credits of the imagery and terrain sources the last frame showed, deduplicated, required ones first (F254). */
  credits(): readonly Credit[];
  /** The imagery layers (ADR 0038): their order, opacity, visibility and blend mode, changeable at runtime (F243–F246). */
  readonly imageryLayers: ImageryLayers;
  /**
   * Drops every tile of the imagery or terrain source with this id from GPU and RAM memory, with its no-data and
   * failure marks, so the view loads it again (a new offline package version, F279). False when no source has the id.
   */
  reloadSource(sourceId: string): boolean;
  /**
   * Adds a glTF 2.0 model at a coordinate with heading, pitch, roll and scale relative to the local east, north and up
   * axes (F361). Resolves with a handle once it is loaded; rejects with a GlobeError for invalid options or a file the
   * loader cannot read. Call after `ready`.
   */
  addModel(options: ModelOptions): Promise<ModelHandle>;
  /** Test hook: forces a GPU device or context loss, which the engine must recover from (F066, F067). */
  simulateDeviceLoss(): void;
  /**
   * Test hook: draws a frame now and returns its pixels as the canvas holds them (ADR 0012: tests read frames from the
   * engine, never from page screenshots). Resolves after `ready`; rejects with 'destroyed' after `destroy()`.
   */
  captureFrame(): Promise<FrameCapture>;
  /** Frees GPU memory, RAM, workers and listeners; later calls throw a GlobeError with code 'destroyed'. */
  destroy(): void;
}
