import type { TileMeshData } from '../surface/surface-mesh.js';
import type { GlobeError } from './errors.js';

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
  readonly view: Float64Array;
  readonly projection: Float64Array;
  readonly eyeEcef: Float64Array;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly pixelRatio: number;
}

/** GPU resource counters, all zero after destroy (F068). */
export interface ResourceCounts {
  /** Surface and debug meshes held on the GPU. */
  readonly meshes: number;
  readonly textures: number;
  readonly gpuBytes: number;
  /** WebGL2 vertex array objects held (0 on WebGPU), which must follow the meshes (KB-021). */
  readonly vertexArrays: number;
  /** GPU devices or contexts held: 1 while the globe runs, 0 once released. */
  readonly contexts: number;
}

/** Cumulative renderer counters for diagnostics and tests (F052). */
export interface RendererStats {
  /** Draw calls in the last frame. */
  readonly drawCalls: number;
  /** Triangles in the last frame. */
  readonly triangles: number;
  /** Texture uploads since the renderer started. */
  readonly textureUploads: number;
  /** Automatic object matrix updates since the renderer started (tiles must cause none). */
  readonly matrixUpdates: number;
  /**
   * Render pipelines compiled since the warm-up before the first frame (ADR 0010 §4): 0 while only the warmed-up
   * material variants draw. Debug shapes have their own materials and count.
   */
  readonly pipelineCompiles: number;
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
  /** Calls `callback` when the container's CSS size or the device pixel ratio changes; returns an unsubscribe. */
  observeSize(callback: () => void): () => void;
  /**
   * Optional: called at the start of every frame to catch a size or pixel-ratio change the browser reported no event
   * for; it reports one through the `observeSize` callback. Runs every frame, so it must not allocate.
   */
  checkSize?(): void;
  /** Calls `callback` with false when the page is hidden and true when it is shown again; returns an unsubscribe. */
  observeVisibility(callback: (visible: boolean) => void): () => void;
  /** The container's CSS size. */
  containerSize(): { widthPx: number; heightPx: number };
  /** Device pixel ratio. */
  pixelRatio(): number;
}

/** Callbacks a renderer uses to report device events to the engine. */
export interface RendererEvents {
  deviceLost(reason: string): void;
  deviceRestored(): void;
  backendFallback(reason: string): void;
  failed(error: GlobeError): void;
}

/** The engine's renderer interface; three.js stays behind it (ADR 0010). */
export interface RendererBackend {
  readonly capabilities: RendererCapabilities;
  readonly host: RenderHost;
  /** The element that receives input (the canvas). */
  readonly inputElement: unknown;
  /** Uploads a surface tile mesh; returns false while the renderer cannot accept it. */
  addMesh(mesh: TileMeshData): void;
  removeMesh(key: number): void;
  /** Loads the pinned base imagery (an equirectangular world image); resolves when it is on the GPU. */
  setBaseImagery(url: string): Promise<void>;
  /** Replaces the debug quads. */
  setDebugMeshes(meshes: readonly DebugMeshData[]): void;
  /** Cumulative counters. */
  stats(): RendererStats;
  /** Draws the listed surface tiles. */
  render(view: FrameView, keys: readonly number[], count: number): void;
  resize(widthPx: number, heightPx: number, pixelRatio: number): void;
  resourceCounts(): ResourceCounts;
  /** Test hook: forces a device or context loss. */
  simulateDeviceLoss(): void;
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
}

/** An input plug-in instance. */
export interface Controls {
  destroy(): void;
}

/** Creates input handling on the renderer's input element. */
export type ControlsFactory = (element: unknown, navigation: NavigationApi) => Controls;

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
}

/** Initial camera. */
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
  /** Multiplies the device pixel ratio (default 1). */
  readonly resolutionScale?: number;
  /** Largest projected geometric error, in CSS pixels (default 1). */
  readonly maxScreenErrorPx?: number;
}

/** Events and their payloads. */
export interface GlobeEvents {
  /** The first complete frame was drawn. */
  ready: { readonly backend: BackendName };
  /** A frame was drawn. The payload object is reused: read it inside the handler, do not keep it. */
  frame: { readonly frameNumber: number; readonly tiles: number };
  /** Rendering stopped because nothing changes. The payload object is reused: read it inside the handler. */
  idle: { readonly frameNumber: number };
  'camera-change': CameraState;
  'device-lost': { readonly reason: string };
  'device-restored': Record<string, never>;
  'backend-fallback': { readonly reason: string };
  error: GlobeError;
}

/** A globe engine instance. */
export interface Globe {
  /** Resolves after the first complete frame; rejects with a GlobeError when the engine cannot start. */
  readonly ready: Promise<void>;
  /** Active backend, available after `ready`. */
  readonly backend: BackendName | undefined;
  /** Device capabilities, available after `ready`. */
  readonly capabilities: RendererCapabilities | undefined;
  /**
   * Current camera, applied values. Before the viewport has a size (until the renderer starts), the requested view, with
   * `rangeMeters` and `altitudeMeters` NaN.
   */
  readonly camera: CameraState;
  /** Frames drawn since creation. */
  readonly frameNumber: number;
  /** Input intents, used by the controls plug-in and available to applications. */
  readonly navigation: NavigationApi;
  /**
   * Moves the camera in one frame (before `ready`, the start view becomes this one). Invalid input throws a GlobeError
   * and leaves the camera unchanged.
   */
  jumpTo(target: ViewInit): void;
  /**
   * The WGS84 position shown at a screen point, or undefined off the globe or before the viewport has a size. A point
   * without finite `xPx` and `yPx` throws a GlobeError ('invalid-coordinate').
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
  /** Draws test quads (scenario tests of jitter and depth); an empty list removes them. */
  setDebugShapes(shapes: readonly DebugShape[]): void;
  /** Test hook: forces a GPU device or context loss, which the engine must recover from (F066, F067). */
  simulateDeviceLoss(): void;
  /** Frees GPU memory, RAM, workers and listeners; later calls throw a GlobeError with code 'destroyed'. */
  destroy(): void;
}
