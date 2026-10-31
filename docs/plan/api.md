# Data structures and public API

Sketches of the main types. They fix names, responsibilities and units; exact signatures are settled when each milestone is built and documented by TSDoc. Angles are degrees in the public API and radians internally; distances are meters; screen sizes are CSS pixels unless a name says otherwise.

## Engine facade (`@vibeglobe/core`)

```ts
import { createGlobe } from '@vibeglobe/core';
import { createRenderer } from '@vibeglobe/renderer';
import { createControls } from '@vibeglobe/controls';
import { xyzImagery, terrariumTerrain } from '@vibeglobe/sources';

const globe = createGlobe({
  container: document.querySelector('#map')!,
  renderer: createRenderer({ backend: 'auto' }), // 'auto' | 'webgpu' | 'webgl2'
  controls: createControls(),
  imagery: [xyzImagery({ url: 'https://tiles.example.com/{z}/{x}/{y}.webp', attribution: '…' })],
  terrain: terrariumTerrain({ url: '…' }),
  view: { longitudeDeg: 9.19, latitudeDeg: 45.46, zoom: 3 },
  network: { mode: 'hybrid' },
});

await globe.ready; // first complete frame from the pinned base
await globe.flyTo({ longitudeDeg: 139.69, latitudeDeg: 35.68, zoom: 15 });
globe.destroy(); // frees GPU memory, RAM, workers, listeners
```

```ts
interface GlobeOptions {
  container: HTMLElement;
  renderer: RendererFactory;
  controls?: ControlsFactory;
  imagery?: ImageryLayerInput[];
  terrain?: TerrainSource;
  view?: ViewInit; // initial camera
  viewMode?: ViewMode; // default 'auto'
  constraints?: CameraConstraints;
  network?: NetworkOptions;
  loading?: Partial<LoadingSwitches>; // global switches, all true by default
  quality?: QualityPreset | 'auto';
  resolutionScale?: number; // multiplies devicePixelRatio
  memory?: { gpuBudgetBytes?: number; ramBudgetBytes?: number };
  assets?: { workerUrl?: string; wasmBaseUrl?: string }; // same-origin only (ADR 0011)
  workers?: { maxCount?: number }; // default clamp(hardwareConcurrency - 2, 1, 4)
  logger?: LoggerOptions;
}

interface Globe {
  readonly ready: Promise<void>;
  readonly backend: 'webgpu' | 'webgl2';
  readonly camera: CameraState; // applied values, read-only snapshot
  readonly view: ViewController; // modes, chosen tilt/heading
  readonly layers: LayerStack;
  readonly network: NetworkController;
  readonly debug: DebugController;

  flyTo(target: CameraTarget, options?: FlyToOptions): CameraAnimation;
  easeTo(target: CameraTarget, options?: EaseToOptions): CameraAnimation;
  jumpTo(target: CameraTarget): void;
  tour(waypoints: readonly TourWaypoint[]): CameraAnimation;
  fitBounds(bounds: GeoBounds, options?: { paddingPx?: Padding }): CameraAnimation;

  pick(screenPoint: ScreenPoint): Promise<PickResult | undefined>;
  getElevation(position: GeoPosition): number | undefined; // best available, synchronous
  getElevationPrecise(position: GeoPosition): Promise<number>; // loads the finest level
  screenToGeo(screenPoint: ScreenPoint): GeoPosition | undefined;
  geoToScreen(position: GeoPosition): GeoScreenPoint | undefined; // behindGlobe: hidden by the globe (F653)

  getViewState(): ViewState; // serializable (URL or JSON)
  setViewState(state: ViewState): void;
  screenshot(options?: { widthPx?: number; heightPx?: number }): Promise<Blob>;

  on<E extends keyof GlobeEvents>(event: E, handler: (payload: GlobeEvents[E]) => void): () => void;
  resize(): void;
  destroy(): void;
}

/** Resolves when the animation completes, rejects with an AbortError when interrupted. */
interface CameraAnimation extends Promise<void> {
  cancel(): void;
}
```

## Camera and view modes

```ts
type ViewMode = 'auto' | '2d' | 'manual';

interface CameraState {
  longitudeDeg: number;
  latitudeDeg: number;
  zoom: number; // continuous, fractional
  altitudeMeters: number; // above the ellipsoid
  headingDeg: number; // applied
  tiltDeg: number; // applied
  morph: number; // 0 = globe, 1 = flat
  reliefScale: number;
}

interface ViewController {
  readonly mode: ViewMode;
  readonly chosenTiltDeg: number | undefined; // undefined in 'auto'
  readonly chosenHeadingDeg: number;
  setAuto(): void; // zoom-driven curves
  set2D(): void; // tilt locked to 0°, morph still active
  set3D(tiltDeg?: number): void; // manual mode with a default tilt
  setHeading(headingDeg: number): void;
  resetNorth(): void;
}

interface CameraConstraints {
  minZoom?: number;
  maxZoom?: number;
  maxTiltDeg?: number;
  bounds?: GeoBounds;
  terrainCollision?: boolean; // default true
}
```

Internally the camera holds `chosen` and `applied` orientation; constraints write only `applied`, which relaxes back toward `chosen` as soon as the constraint allows.

## Tiles

```ts
type TileKey = number; // packed root + quadtree index, exact up to level 25
interface TileCoord {
  root: 0 | 1 | 2; // 0 Web Mercator, 1 north polar cap, 2 south polar cap (ADR 0006, ADR 0013)
  level: number;
  x: number;
  y: number;
}

interface TilingScheme {
  readonly crs: string; // e.g. 'EPSG:3857', 'EPSG:4326', 'EPSG:32632'
  readonly rootTilesX: number;
  readonly rootTilesY: number;
  tileExtent(coord: TileCoord, out: GeoRectangle): GeoRectangle;
  tilesAt(position: GeoPosition, level: number): TileCoord;
}

type TileState =
  'unloaded' | 'queued' | 'loading' | 'decoding' | 'decoded' | 'uploading' | 'ready' | 'failed' | 'noData';
```

## Sources and provider profiles

```ts
interface SourceMetadata {
  id: string;
  kind: 'imagery' | 'terrain' | 'vector' | '3d';
  tilingScheme: TilingScheme;
  coverage?: GeoBounds | GeoBounds[]; // tiles outside are never requested
  minLevel: number;
  maxLevel: number;
  tileSizePx?: 256 | 512 | number;
  pixelRatio?: 1 | 2; // @2x tiles
  attribution: Attribution;
  profile: ProviderProfile;
  auth?: { headers?: Record<string, string>; token?: () => Promise<string> };
  rateLimit?: { maxConcurrent?: number; perSecond?: number };
}

interface TileSource<TDecoded> {
  readonly metadata: SourceMetadata;
  /** Describes how to fetch a tile; the scheduler, cache and packages handle transport. */
  request(coord: TileCoord): TileRequest | 'noData';
  /** Worker-side decoder id and options, so decoding never runs on the main thread. */
  readonly decoder: DecoderRef<TDecoded>;
}

interface ProviderProfile {
  id: string; // 'google', 'osm-public', 'osm-selfhosted', 'custom', …
  forbids: ReadonlySet<keyof LoadingSwitches>; // a profile can only switch features off
  respectCacheHeaders: boolean;
  maxConcurrentRequests?: number;
  requiredAttribution: Attribution; // text and/or logo, never covered
  sessionRenewalSeconds?: number; // e.g. Google 3D sessions
  termsAdr: string; // ADR recording the terms reading
}

interface Attribution {
  text: string;
  url?: string;
  logo?: { src: string; alt: string };
}
```

Layer composition: `ImageryLayerInput` is either a source or `{ sources: TileSource[] /* priority chain */, opacity, visible, blend, harmonize }`; the chain falls back by coverage and availability.

## Loading policy and caches

```ts
type NetworkMode = 'online' | 'offline' | 'hybrid';

interface LoadingSwitches {
  persistentCache: boolean;
  memoryReuse: boolean;
  prefetch: boolean; // also flight preloading
  offlinePackaging: boolean;
}

interface NetworkController {
  mode: NetworkMode; // settable at runtime
  setSwitches(switches: Partial<LoadingSwitches>, scope?: { layerId?: string; sourceId?: string }): void;
  readonly connectivity: 'online' | 'offline' | 'degraded';
  readonly bandwidthBytesPerSecond: number | undefined;
}

interface CacheStore {
  get(key: string): Promise<CachedTile | undefined>;
  put(key: string, tile: CachedTile): Promise<void>;
  delete(key: string): Promise<void>;
  usage(): Promise<{ bytes: number; quotaBytes: number | undefined }>;
}
```

## Offline packages (`@vibeglobe/offline`)

```ts
interface OfflinePackageManifest {
  id: string;
  version: string;
  sources: { sourceId: string; minLevel: number; maxLevel: number; license: string; attribution: Attribution }[];
  area: GeoBounds | GeoPolygon;
  files: { path: string; bytes: number; sha256: string }[];
}

interface PackageManager {
  list(): Promise<InstalledPackage[]>;
  estimate(request: PackageRequest): Promise<{ tiles: number; bytes: number }>;
  install(
    from: URL | File | PackageRequest,
    options?: { signal?: AbortSignal; onProgress?: (p: Progress) => void },
  ): Promise<InstalledPackage>;
  update(id: string): Promise<InstalledPackage>;
  remove(id: string): Promise<void>;
  storageUsage(): Promise<{ bytes: number; quotaBytes: number | undefined; persisted: boolean }>;
  requestPersistentStorage(): Promise<boolean>;
}
```

## Data layers (`@vibeglobe/layers`)

```ts
const sensors = globe.layers.add(
  pointLayer({
    data: featureCollection, // or an async iterable stream
    placement: 'clamp-to-ground', // | 'drape' | { absoluteAltitudeMeters: number }
    style: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 2, 15, 8], 'circle-color': ['get', 'color'] },
    cluster: { radiusPx: 60 },
  }),
);

sensors.updateFeature('s-42', { position: [9.2, 45.5], properties: { color: '#f00' } });
sensors.setFeatureVisible('s-42', false);
sensors.on('click', (event) => console.log(event.feature, event.position, event.screenPoint));
```

Layer kinds: `pointLayer`, `labelLayer`, `polylineLayer`, `polygonLayer` (with extrusion), `circleLayer`, `modelLayer` (glTF), `vectorTileLayer` (MVT + MapLibre style), `tileset3dLayer` (3D Tiles). Styles use MapLibre Style Specification expressions.

## Events

```ts
interface GlobeEvents {
  'backend-ready': { backend: 'webgpu' | 'webgl2' };
  'move-start': { cause: 'user' | 'animation' };
  'camera-change': CameraState;
  'move-end': CameraState;
  'view-mode-change': { mode: ViewMode };
  idle: void; // nothing moving, every visible tile ready
  'tile-load': { sourceId: string; coord: TileCoord };
  'tile-error': { sourceId: string; coord: TileCoord; reason: TileErrorReason };
  'connectivity-change': { connectivity: 'online' | 'offline' | 'degraded' };
  'device-lost': { reason: string };
  'device-restored': void; // renderer recreated after a loss (ADR 0010, ADR 0013)
  'backend-fallback': { from: 'webgpu'; to: 'webgl2'; reason: string }; // WebGPU startup self-test failed
  error: EngineError; // code 'renderer-failed' after three failed recoveries in 60 s
}
```

## Renderer, controls and network policy plug-ins

The engine owns every globe decision and hands the renderer a finished description of the frame (ADR 0010 picks the implementation, ADR 0004 and ADR 0005 fix precision and depth).

```ts
interface RendererFactory {
  (context: { canvas: HTMLCanvasElement; backend: 'auto' | 'webgpu' | 'webgl2' }): Promise<RendererBackend>;
}

interface RendererBackend {
  readonly kind: 'webgpu' | 'webgl2';
  readonly capabilities: GpuCapabilities; // limits, compressed formats, timestamp queries, clip control
  createTexture(source: ImageBitmap | CompressedTextureData, options: TextureOptions): TextureHandle;
  createMesh(data: MeshData): MeshHandle; // float32 offsets from a float64 origin (ADR 0004)
  release(handle: TextureHandle | MeshHandle): void;
  /** Draws one frame: rotation-only view, per-draw eye-relative offsets, cross-fade alphas, overlays. */
  render(frame: FrameDescription): void;
  readPixels(region: ScreenRect): Promise<Uint8Array>; // picking, screenshots, visual tests
  onDeviceLost(handler: (reason: string) => void): () => void;
  resize(widthPx: number, heightPx: number, pixelRatio: number): void;
  destroy(): void;
}

interface FrameDescription {
  view: Float64Array; // rotation-only view matrix
  projection: Float64Array; // reversed-Z, infinite far plane
  draws: readonly DrawCommand[]; // state-sorted by the engine
}

interface Controls {
  attach(element: HTMLElement, camera: CameraInput): void; // camera input API from core
  /** Applies the input recorded since the last frame; called once per frame by the engine loop. */
  update(nowMs: number): void;
  detach(): void;
}

interface NetworkPolicy {
  /** Decides, per request, which tiers may be used and whether the network may be touched. */
  resolve(request: { sourceId: string; layerId: string; purpose: 'visible' | 'prefetch' | 'package' }): {
    useNetwork: boolean;
    readPackages: boolean;
    readPersistentCache: boolean;
    writePersistentCache: boolean;
    keepInMemory: boolean;
  };
}
```

## Plug-in interfaces defined by core

| Interface                                              | Implemented by                     |
| ------------------------------------------------------ | ---------------------------------- |
| `RendererBackend` (+ `RendererFactory`)                | `@vibeglobe/renderer`              |
| `TileSource`, `DecoderRef`, `TilingScheme`             | `@vibeglobe/sources`, applications |
| `CacheStore`                                           | `@vibeglobe/offline`               |
| `NetworkPolicy` (resolves mode, switches and profiles) | core default; replaceable          |
| `Controls` (+ `ControlsFactory`)                       | `@vibeglobe/controls`              |
| `Geocoder`                                             | applications (no default provider) |
| `Layer`                                                | `@vibeglobe/layers`, applications  |

## Framework adapters

```vue
<VibeGlobe :view="{ longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 5 }" view-mode="auto" @move-end="onMoveEnd">
  <template #controls><GlobeControls /></template>
</VibeGlobe>
```

```html
<script type="module">
  import { defineVibeGlobe } from '@vibeglobe/web-component';
  defineVibeGlobe();
</script>
<vibe-globe longitude="12.5" latitude="41.9" zoom="5" view-mode="auto"></vibe-globe>
```
