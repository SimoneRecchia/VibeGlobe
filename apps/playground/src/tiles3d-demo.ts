/**
 * The playground's 3D Tiles scenarios (M13, F461–F467, F471; ADR 0141), loaded on `?scenario=3dtiles-*`:
 * `3dtiles-city` streams the generated fixture city (`e2e/fixtures/tiles3d/city.ts`, served from `public/tiles3d/`)
 * through the 3D Tiles render extension. URL parameters: `tiles3d=plain|draco|meshopt|ktx2` (the variant),
 * `tileset=<url>` (another tileset), `sse=<px>` (maximum screen-space error), `budgetMb=<n>` (content budget),
 * `decoders=<url>` (where `draco_decoder.wasm` is hosted, F463), `debug3dtiles` (each drawn tile's level and
 * screen-space error over it). Clicks pick features. `window.vibeglobeTiles3d` exposes the extension.
 */
import { ecefToGeodetic, type GeodeticRad, type Globe } from '@vibeglobe/core';
import { threeTileMeshes } from '@vibeglobe/renderer/tiles3d';
import {
  tiles3d,
  type RequestEvent,
  type Tiles3DExtension,
  type Tiles3DOptions,
  type Tiles3DPick,
} from '@vibeglobe/sources/tiles3d';
import dracoWasmUrl from 'draco3d/draco_decoder.wasm?url';

/** What tests read (`window.vibeglobeTiles3d`). */
export interface Tiles3DTestHooks {
  readonly extension: Tiles3DExtension;
  /** Every request event since the start. */
  readonly requests: RequestEvent[];
  /** Every click's pick (undefined over no tile), latest last. */
  readonly picks: (Tiles3DPick | undefined)[];
  /** Errors of tiles that failed. */
  readonly errors: string[];
}

declare global {
  interface Window {
    vibeglobeTiles3d?: Tiles3DTestHooks;
  }
}

/** The city's center (that of the fixture). */
const CITY = { longitudeDeg: 12.4922, latitudeDeg: 41.8902 };

/** Shows each drawn tile's level and screen-space error at its center, updated every frame. */
function debugOverlay(globe: Globe, app: HTMLElement, extension: Tiles3DExtension): void {
  const layer = document.createElement('div');
  layer.className = 'vg-tiles3d-debug';
  layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;font:11px monospace;color:#fff;';
  app.append(layer);
  const g: GeodeticRad = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };
  globe.on('frame', () => {
    const labels = extension.debugTiles().map((tile) => {
      const [x = 0, y = 0, z = 0] = tile.centerEcef;
      ecefToGeodetic(x, y, z, g);
      const at = globe.geoToScreen({
        longitudeDeg: (g.longitudeRad * 180) / Math.PI,
        latitudeDeg: (g.latitudeRad * 180) / Math.PI,
        heightMeters: g.heightMeters,
      });
      const label = document.createElement('span');
      label.className = 'vg-tiles3d-tile';
      label.dataset['tile'] = tile.id;
      label.dataset['level'] = String(tile.level);
      label.dataset['sse'] = tile.screenSpaceErrorPx.toFixed(1);
      label.textContent = `L${tile.level} ${tile.screenSpaceErrorPx.toFixed(1)} px`;
      label.style.cssText = `position:absolute;left:${at?.xPx ?? -999}px;top:${at?.yPx ?? -999}px;background:#0008;padding:0 2px;`;
      return label;
    });
    layer.replaceChildren(...labels);
  });
}

/** The extension's options for the URL. */
export function tilesetOptions(params: URLSearchParams, base: string): Tiles3DOptions {
  const variant = params.get('tiles3d') ?? 'plain';
  const sse = Number(params.get('sse'));
  const budgetMb = Number(params.get('budgetMb'));
  return {
    url: params.get('tileset') ?? new URL(`${base}tiles3d/city-${variant}/tileset.json`, location.href).href,
    id: 'fixture-city',
    meshes: threeTileMeshes,
    ...(sse > 0 ? { maximumScreenSpaceError: sse } : {}),
    ...(budgetMb > 0 ? { memoryBudgetBytes: budgetMb * 1024 * 1024 } : {}),
  };
}

/**
 * The model worker the loader falls back to on an engine whose worker program lacks `parse-model`; the engine's own
 * workers decode first, with the Draco decoder from `decoders=` (F463) or the bundled file. Development server only: the worker bundles meshoptimizer's
 * decoder, whose Blob-worker code production bundles refuse (F100), so a production playground decodes 3D Tiles
 * content once the worker program registers the task.
 */
async function devDecoding(dracoWasm: string): Promise<Pick<Tiles3DOptions, 'modelWorker'>> {
  if (!import.meta.env.DEV) return {};
  const { devModelWorker } = await import('./tiles3d-dev-decoding.js');
  return { modelWorker: devModelWorker(dracoWasm) };
}

/** Adds the scenario's tileset to the globe and frames the city unless the URL sets a view. */
export async function showTiles3DScenario(
  globe: Globe,
  app: HTMLElement,
  params: URLSearchParams,
): Promise<Tiles3DTestHooks | undefined> {
  const requests: RequestEvent[] = [];
  const picks: (Tiles3DPick | undefined)[] = [];
  const errors: string[] = [];
  let extension: Tiles3DExtension | undefined;
  const chosen = tilesetOptions(params, import.meta.env.BASE_URL);
  const dracoWasm = new URL(params.get('decoders') ?? dracoWasmUrl, location.href).href;
  const options = { ...chosen, dracoWasmUrl: dracoWasm, ...(await devDecoding(dracoWasm)) };
  globe.addRenderExtension(
    tiles3d(
      {
        ...options,
        onRequest: (event) => requests.push(event),
        onTileError: (tile, message) => errors.push(`${tile}: ${message}`),
      },
      (created) => (extension = created),
    ),
  );
  if (!extension) throw new Error('the 3D Tiles extension was not created');
  if (!params.has('lon')) void globe.jumpTo({ ...CITY, zoom: 15.5, tiltDeg: 45 });
  if (params.has('debug3dtiles')) debugOverlay(globe, app, extension);
  const ext = extension;
  app.addEventListener('click', (event) => {
    const box = app.getBoundingClientRect();
    try {
      picks.push(ext.pick(event.clientX - box.left, event.clientY - box.top));
    } catch (error) {
      // A display-only source's tiles refuse picking (F326).
      errors.push(error instanceof Error ? error.message : String(error));
    }
  });
  const hooks: Tiles3DTestHooks = { extension: ext, requests, picks, errors };
  window.vibeglobeTiles3d = hooks;
  return hooks;
}
