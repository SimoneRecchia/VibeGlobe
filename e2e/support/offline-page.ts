// The offline harness page (e2e/support/offline.html): the playground's globe with its fixture imagery wrapped by
// @vibeglobe/offline, driven by the offline track's end-to-end tests through `window.offlineHarness`. It uses the
// engine's public API only and runs on the playground's dev server, which serves the fixture tiles.
import { createControls } from '@vibeglobe/controls';
import { createGlobe, type Globe, type ImagerySource, type ViewInit } from '@vibeglobe/core';
import {
  type ArchiveAdapters,
  createOffline,
  createPackageManager,
  type LoadingSwitches,
  type NetworkMode,
  type Offline,
  type BuildReport,
  type InstalledPackage,
  type PackageArea,
  type PackageManager,
  type PackageManifest,
  type ProviderRules,
  type ServeEvent,
  type SourceCachePolicy,
} from '@vibeglobe/offline';
import { createRenderer } from '@vibeglobe/renderer';
import { createDebugOverlay, type DebugOverlay } from '@vibeglobe/ui';
import type * as PluginModule from '../fixtures/offline-plugin/index.ts';
import { buildFixturePackage, type FixturePackageSpec } from './offline-fixtures.ts';
import {
  googleImagery,
  heightmapTerrain,
  openStreetMapHostedImagery,
  openStreetMapImagery,
  pmtilesImagery,
  withProfile,
  xyzImagery,
  type Attribution,
  type ProviderProfile,
} from '@vibeglobe/sources';
import { mbtilesImagery } from '@vibeglobe/sources/mbtiles';
import { createWorkers } from '@vibeglobe/worker';

/** One imagery source of the harness: fixture tiles of a pattern, or any URL template. */
interface HarnessSource {
  readonly id: string;
  /** Fixture pattern served by the dev server (`world`, `levels`, …), or a full URL template in `url`. */
  readonly pattern?: string;
  readonly url?: string;
  readonly session?: string;
  readonly minLevel?: number;
  readonly maxLevel?: number;
  readonly layerId?: string;
  /** Provider rules; `forbids` as an array (it crosses the page boundary as JSON). */
  readonly rules?: {
    readonly id: string;
    readonly forbids: readonly (keyof LoadingSwitches)[];
    readonly respectCacheHeaders: boolean;
  };
  readonly cachePolicy?: SourceCachePolicy;
  /**
   * A provider adapter instead of the plain XYZ one: Google 2D tiles (the test routes tile.googleapis.com to its
   * fixture), the OpenStreetMap public servers or self-hosted OpenStreetMap tiles (both at `url` or the fixture tiles).
   */
  readonly provider?: 'google' | 'osm-public' | 'osm-hosted';
  /** A profile the source declares (F326), or the commercial provider's profile of `osm-hosted` (F325). */
  readonly profile?: {
    readonly id: string;
    readonly forbids: readonly (keyof LoadingSwitches)[];
    readonly respectCacheHeaders: boolean;
    readonly maxConcurrentRequests?: number;
    readonly requiredAttribution?: Attribution;
  };
  /** Credits the source declares. */
  readonly attribution?: readonly Attribution[];
  /** The license recorded when the source is packaged (default CC-BY-4.0). */
  readonly license?: string;
}

/** What a test starts. */
export interface HarnessConfig {
  readonly network?: NetworkMode;
  readonly switches?: Partial<LoadingSwitches>;
  readonly sources: readonly HarnessSource[];
  readonly store?: 'main-thread' | 'memory';
  readonly cacheBytes?: number;
  readonly view?: ViewInit;
  readonly backend?: 'auto' | 'webgpu' | 'webgl2';
  readonly healthChecks?: { minIntervalMs?: number; maxIntervalMs?: number };
  /** Switch overrides per source or layer, applied at start. */
  readonly switchScopes?: readonly {
    readonly switches: Partial<LoadingSwitches>;
    readonly scope: { readonly sourceId?: string; readonly layerId?: string };
  }[];
  /** Manifest URLs of packages read from a LAN server without installing (offline mode 1). */
  readonly served?: readonly string[];
  /** Engine time per drawn frame, for frame-by-frame checks of cross-fades. */
  readonly clockStepMs?: number;
  /**
   * Waits for the globe's `ready` (default true). A start with no reachable data for the pinned levels resolves it
   * only once connectivity returns (docs/parallel-tracks.md, hook requests).
   */
  readonly awaitReady?: boolean;
  /** Memory budgets of the engine's GPU and RAM tiers. */
  readonly memory?: { readonly gpuBudgetBytes?: number; readonly ramBudgetBytes?: number };
  /** Shows the debug overlay with the counters of every tier (F272), like the playground's `?debug=1`. */
  readonly debug?: boolean;
  /** Fixture Terrarium terrain wrapped by the offline engine like the imagery (F328). */
  readonly terrain?: { readonly id: string; readonly session: string; readonly maxLevel?: number };
  /** Uses the custom cache store and network policy of `e2e/fixtures/offline-plugin` (F327). */
  readonly plugin?: boolean;
}

/** The harness on the page. */
interface OfflineHarness {
  start(config: HarnessConfig): Promise<void>;
  /** Destroys the globe and creates it again with the same configuration: a page reload without reloading. */
  restartGlobe(): Promise<void>;
  stop(): void;
  readonly offline: Offline | undefined;
  readonly manager: PackageManager | undefined;
  readonly globe: Globe | undefined;
  /** Every tile delivered by a wrapped source since the globe started, in order. */
  readonly served: ServeEvent[];
  readonly events: { type: string; payload: unknown }[];
  readonly integrityErrors: string[];
  /** Builds a fixture package in the page and installs it from local files. */
  installFixture(spec: FixturePackageSpec): Promise<InstalledPackage>;
  /** Builds a fixture package in the page; the file comes back base64-encoded for a test server. */
  buildFixture(spec: FixturePackageSpec): Promise<{ manifest: PackageManifest; path: string; base64: string }>;
  /** Downloads an area of fixture sources into a package in the browser; resolves its report or the error message. */
  buildArea(request: AreaRequest): Promise<{ report?: BuildReport; tiles?: number; error?: string }>;
}

/** An in-browser package build of fixture sources (F289, F319). */
interface AreaRequest {
  readonly id: string;
  readonly version: string;
  readonly area: PackageArea;
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly sources: readonly HarnessSource[];
}

declare global {
  interface Window {
    offlineHarness?: OfflineHarness;
  }
}

const canvas = document.querySelector<HTMLCanvasElement>('#globe');
const container = document.querySelector<HTMLDivElement>('#app');
if (!canvas || !container) throw new Error('the harness page lacks #app or #globe');
// The page is served from /@fs/<repo>/e2e/support/, so sql.js's WebAssembly file (for the MBTiles adapter) is reached
// the same way.
const repo = location.pathname.replace(/\/e2e\/support\/[^/]*$/, '');
const wasmUrl = `${repo}/node_modules/sql.js/dist/sql-wasm.wasm`;
const adapters: ArchiveAdapters = {
  pmtiles: (options) => pmtilesImagery(options),
  mbtiles: (options) => mbtilesImagery({ ...options, wasmUrl }),
};

let config: HarnessConfig | undefined;

async function loadPlugin(): Promise<ReturnType<typeof PluginModule.createPlugin>> {
  const module = (await import(
    /* @vite-ignore */ `${repo}/e2e/fixtures/offline-plugin/index.ts`
  )) as typeof PluginModule;
  const plugin = module.createPlugin();
  (window as unknown as { pluginCounters: Record<string, number> }).pluginCounters = plugin.counters;
  return plugin;
}

/** The fixture tile URL of a harness source. */
function urlOf(s: HarnessSource): string {
  const url = s.url ?? `/fixture-tiles/${s.session ?? 'offline'}/${s.pattern ?? 'world'}/mercator/{z}/{x}/{y}.png`;
  return url.startsWith('/') ? `${location.origin}${url}` : url;
}

function profileOf(s: HarnessSource): ProviderProfile | undefined {
  return s.profile ? { ...s.profile, forbids: new Set(s.profile.forbids) } : undefined;
}

/** The adapter of a harness source, before the offline engine wraps it. */
async function adapterOf(s: HarnessSource): Promise<ImagerySource> {
  const levels = { minLevel: s.minLevel ?? 0, maxLevel: s.maxLevel ?? 18 };
  const profile = profileOf(s);
  if (s.provider === 'google')
    return googleImagery({
      id: s.id,
      apiKey: 'fixture-key',
      billingRegion: 'eea',
      mapType: 'roadmap',
      maxLevel: levels.maxLevel,
    });
  if (s.provider === 'osm-public')
    return openStreetMapImagery({ id: s.id, appName: 'VibeGlobe tests', appUrl: location.origin, url: urlOf(s) });
  if (s.provider === 'osm-hosted')
    return openStreetMapHostedImagery({
      id: s.id,
      url: urlOf(s),
      ...levels,
      ...(profile ? { provider: profile } : {}),
      ...(s.attribution ? { attribution: s.attribution } : {}),
    });
  const source = xyzImagery({ id: s.id, url: urlOf(s), ...levels });
  // A plain fixture source stays as it is unless the test declares a profile or credits (the offline track's specs
  // rely on its default cache behavior).
  return profile || s.attribution ? withProfile(source, profile ?? CUSTOM, s.attribution ?? []) : source;
}

/** The provider rules a source's own profile declares, if any. */
function rulesOf(source: ImagerySource): ProviderRules | undefined {
  const profile = (source as { profile?: unknown }).profile;
  return typeof profile === 'object' && profile !== null && 'forbids' in profile
    ? (profile as ProviderRules)
    : undefined;
}

const CUSTOM: ProviderProfile = { id: 'custom', forbids: new Set(), respectCacheHeaders: true };

async function sourcesOf(offline: Offline, current: HarnessConfig): Promise<ImagerySource[]> {
  return Promise.all(
    current.sources.map(async (s) => {
      const source = await adapterOf(s);
      const rules: ProviderRules | undefined = s.rules ? { ...s.rules, forbids: new Set(s.rules.forbids) } : undefined;
      return offline.source(source, {
        ...(s.layerId ? { layerId: s.layerId } : {}),
        ...(rules ? { rules } : {}),
        ...(s.cachePolicy ? { cachePolicy: s.cachePolicy } : {}),
      });
    }),
  );
}

async function createGlobeFor(offline: Offline, current: HarnessConfig): Promise<Globe> {
  if (!canvas || !container) throw new Error('no canvas');
  const globe = createGlobe({
    container,
    renderer: createRenderer({ backend: current.backend ?? 'auto', canvas }),
    controls: createControls(),
    baseImageryUrl: '/imagery/natural-earth-4096.jpg',
    view: current.view ?? {},
    imagery: await sourcesOf(offline, current),
    ...(current.terrain
      ? {
          terrain: offline.source(
            heightmapTerrain({
              id: current.terrain.id,
              url: `${location.origin}/fixture-tiles/${current.terrain.session}/terrain/mercator/{z}/{x}/{y}.terrarium.png`,
              encoding: 'terrarium',
              maxLevel: current.terrain.maxLevel ?? 12,
            }),
          ),
        }
      : {}),
    workers: createWorkers(),
    ...(current.memory ? { memory: current.memory } : {}),
    ...(current.clockStepMs === undefined ? {} : { manualClockStepMs: current.clockStepMs }),
  });
  if (current.debug) showTiers(globe, offline);
  // The shared end-to-end helpers (waitForIdle, canvasImage) read the playground's hook names.
  (window as unknown as { vibeglobePlayground: unknown }).vibeglobePlayground = { globe, globes: [globe], events: [] };
  return globe;
}

let overlay: DebugOverlay | undefined;

/** The debug overlay's rows: where tiles came from, tier by tier, top tier first (F272). */
function showTiers(globe: Globe, offline: Offline): void {
  overlay?.destroy();
  const panel = createDebugOverlay(container ?? document.body, 'Tile tiers');
  overlay = panel;
  globe.on('frame', () => {
    const imagery = globe.imageryStats();
    const tiers = offline.stats();
    panel.setInfo([
      ['tier-gpu', `GPU tiles ${String(imagery?.ready ?? 0)}`],
      ['tier-ram', `RAM hits ${String(imagery?.ramHits ?? 0)}`],
      ['tier-persistent', `persistent ${String(tiers.persistent + tiers.revalidated)}`],
      ['tier-package', `package ${String(tiers.package)}`],
      ['tier-network', `network ${String(tiers.network)}`],
    ]);
  });
}

const harness: OfflineHarness = {
  offline: undefined,
  manager: undefined,
  globe: undefined,
  served: [],
  events: [],
  integrityErrors: [],
  async start(next) {
    harness.stop();
    config = next;
    const plugin = next.plugin ? await loadPlugin() : undefined;
    const offline = createOffline({
      ...(plugin ? { store: plugin.store, policy: plugin.policy } : {}),
      ...(next.network ? { mode: next.network } : {}),
      ...(next.switches ? { switches: next.switches } : {}),
      ...(next.store ? { store: next.store } : {}),
      ...(next.cacheBytes === undefined ? {} : { cacheBytes: next.cacheBytes }),
      ...(next.healthChecks ? { healthChecks: next.healthChecks } : {}),
      onServe: (event) => harness.served.push(event),
    });
    for (const { switches, scope } of next.switchScopes ?? []) offline.setSwitches(switches, scope);
    for (const type of ['connectivity-change', 'storage-lost', 'warning', 'mode-change'] as const)
      offline.on(type, (payload) => harness.events.push({ type, payload }));
    // Back from offline-only mode, the misses read as no data load again (KB-158).
    offline.on('mode-change', ({ sourceIds }) => {
      for (const id of sourceIds) harness.globe?.reloadSource(id, { missingOnly: true });
    });
    const manager = createPackageManager(offline, {
      adapters,
      onIntegrityError: (event) => harness.integrityErrors.push(`${event.packageId}: ${event.message}`),
      onChange: ({ sourceIds }) => {
        for (const id of sourceIds) harness.globe?.reloadSource(id);
      },
    });
    await manager.ready;
    for (const url of next.served ?? []) await manager.addServedPackage(url);
    Object.assign(harness, { offline, manager, globe: await createGlobeFor(offline, next) });
    if (next.awaitReady !== false) await harness.globe?.ready;
  },
  async restartGlobe() {
    if (!config || !harness.offline) throw new Error('not started');
    harness.globe?.destroy();
    overlay?.destroy();
    overlay = undefined;
    harness.served.length = 0;
    Object.assign(harness, { globe: await createGlobeFor(harness.offline, config) });
    if (config.awaitReady !== false) await harness.globe?.ready;
  },
  async installFixture(spec) {
    if (!harness.manager) throw new Error('not started');
    const built = await buildFixturePackage(spec);
    return harness.manager.install({
      manifest: built.manifest,
      files: { [built.path]: new Blob([built.file as Uint8Array<ArrayBuffer>]) },
    });
  },
  async buildFixture(spec) {
    const built = await buildFixturePackage(spec);
    let binary = '';
    for (let i = 0; i < built.file.length; i += 0x8000)
      binary += String.fromCharCode(...built.file.subarray(i, i + 0x8000));
    return { manifest: built.manifest, path: built.path, base64: btoa(binary) };
  },
  async buildArea(request) {
    if (!harness.manager || !harness.offline) throw new Error('not started');
    try {
      const installed = await harness.manager.install({
        ...request,
        sources: await Promise.all(
          request.sources.map(async (s) => {
            const source = await adapterOf(s);
            const rules = s.rules ? { ...s.rules, forbids: new Set(s.rules.forbids) } : rulesOf(source);
            return {
              source,
              ...(rules ? { rules } : {}),
              license: s.license ?? 'CC-BY-4.0',
              attribution: s.attribution?.[0] ?? { text: `Fixture ${s.pattern ?? 'world'}` },
            };
          }),
        ),
      });
      return { ...(installed.report ? { report: installed.report } : {}), tiles: installed.report?.tiles ?? 0 };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
  stop() {
    overlay?.destroy();
    overlay = undefined;
    harness.globe?.destroy();
    harness.manager?.destroy();
    harness.offline?.destroy();
    Object.assign(harness, { globe: undefined, manager: undefined, offline: undefined });
    harness.served.length = 0;
  },
};

window.offlineHarness = harness;
