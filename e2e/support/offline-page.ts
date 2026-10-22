// The offline harness page (e2e/support/offline.html): the playground's globe with its fixture imagery wrapped by
// @vibeglobe/offline, driven by the offline track's end-to-end tests through `window.offlineHarness`. It uses the
// engine's public API only and runs on the playground's dev server, which serves the fixture tiles.
import { createControls } from '@vibeglobe/controls';
import { createGlobe, type Globe, type ViewInit } from '@vibeglobe/core';
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
import { buildFixturePackage, type FixturePackageSpec } from './offline-fixtures.ts';
import { xyzImagery } from '@vibeglobe/sources';
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
// The page is served from /@fs/<repo>/e2e/support/: the typed stub of the M7 archive adapters and sql.js's
// WebAssembly file are reached the same way (docs/parallel-tracks.md).
const repo = location.pathname.replace(/\/e2e\/support\/[^/]*$/, '');
const stub = (await import(/* @vite-ignore */ `${repo}/packages/offline/src/__fixtures__/archive-adapters.ts`)) as {
  createStubAdapters(options: { wasmUrl?: string }): ArchiveAdapters;
};
const adapters = stub.createStubAdapters({ wasmUrl: `${repo}/node_modules/sql.js/dist/sql-wasm.wasm` });

let config: HarnessConfig | undefined;

function sourcesOf(offline: Offline, current: HarnessConfig): ReturnType<typeof xyzImagery>[] {
  return current.sources.map((s) => {
    const url = s.url ?? `/fixture-tiles/${s.session ?? 'offline'}/${s.pattern ?? 'world'}/mercator/{z}/{x}/{y}.png`;
    const source = xyzImagery({
      id: s.id,
      url: url.startsWith('/') ? `${location.origin}${url}` : url,
      minLevel: s.minLevel ?? 0,
      maxLevel: s.maxLevel ?? 18,
    });
    const rules: ProviderRules | undefined = s.rules ? { ...s.rules, forbids: new Set(s.rules.forbids) } : undefined;
    return offline.source(source, {
      ...(s.layerId ? { layerId: s.layerId } : {}),
      ...(rules ? { rules } : {}),
      ...(s.cachePolicy ? { cachePolicy: s.cachePolicy } : {}),
    });
  });
}

function createGlobeFor(offline: Offline, current: HarnessConfig): Globe {
  if (!canvas || !container) throw new Error('no canvas');
  const globe = createGlobe({
    container,
    renderer: createRenderer({ backend: current.backend ?? 'auto', canvas }),
    controls: createControls(),
    baseImageryUrl: '/imagery/natural-earth-4096.jpg',
    view: current.view ?? {},
    imagery: sourcesOf(offline, current),
    workers: createWorkers(),
  });
  // The shared end-to-end helpers (waitForIdle, canvasImage) read the playground's hook names.
  (window as unknown as { vibeglobePlayground: unknown }).vibeglobePlayground = { globe, globes: [globe], events: [] };
  return globe;
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
    const offline = createOffline({
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
    const manager = createPackageManager(offline, {
      adapters,
      onIntegrityError: (event) => harness.integrityErrors.push(`${event.packageId}: ${event.message}`),
    });
    await manager.ready;
    for (const url of next.served ?? []) await manager.addServedPackage(url);
    Object.assign(harness, { offline, manager, globe: createGlobeFor(offline, next) });
    await harness.globe?.ready;
  },
  async restartGlobe() {
    if (!config || !harness.offline) throw new Error('not started');
    harness.globe?.destroy();
    harness.served.length = 0;
    Object.assign(harness, { globe: createGlobeFor(harness.offline, config) });
    await harness.globe?.ready;
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
        sources: request.sources.map((s) => ({
          source: xyzImagery({
            id: s.id,
            url: `${location.origin}/fixture-tiles/${s.session ?? 'offline'}/${s.pattern ?? 'world'}/mercator/{z}/{x}/{y}.png`,
          }),
          ...(s.rules ? { rules: { ...s.rules, forbids: new Set(s.rules.forbids) } } : {}),
          license: 'CC-BY-4.0',
          attribution: { text: `Fixture ${s.pattern ?? 'world'}` },
        })),
      });
      return { ...(installed.report ? { report: installed.report } : {}), tiles: installed.report?.tiles ?? 0 };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
  stop() {
    harness.globe?.destroy();
    harness.manager?.destroy();
    harness.offline?.destroy();
    Object.assign(harness, { globe: undefined, manager: undefined, offline: undefined });
    harness.served.length = 0;
  },
};

window.offlineHarness = harness;
