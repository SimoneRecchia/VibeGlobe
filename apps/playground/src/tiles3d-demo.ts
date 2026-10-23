/**
 * The playground's 3D Tiles scenarios (M13, F461–F467, F471; ADR 0141), loaded on `?scenario=3dtiles-*`:
 * `3dtiles-city` streams the generated fixture city (`e2e/fixtures/tiles3d/city.ts`, served from `public/tiles3d/`)
 * through the 3D Tiles render extension. URL parameters: `tiles3d=plain|draco|meshopt|ktx2` (the variant),
 * `tileset=<url>` (another tileset), `sse=<px>` (maximum screen-space error), `budgetMb=<n>` (content budget),
 * `decoders=<url>` (where `draco_decoder.wasm` is hosted, F463), `debug3dtiles` (each drawn tile's level and
 * screen-space error over it). `3dtiles-google` streams Google Photorealistic 3D Tiles over Rome with the key of
 * `googleKey=` (the customer's own, never committed; without it a configuration message shows and the globe runs on),
 * `googleRegion=eea|other` (billing region, default `other`), `googleBase=` (a Map Tiles API stand-in) and
 * `googleSessionMs=` (session lifetime). Clicks pick features. `window.vibeglobeTiles3d` exposes the extension.
 */
import { ecefToGeodetic, type GeodeticRad, type Globe } from '@vibeglobe/core';
import { createModelTasks, loadDraco3d } from '@vibeglobe/models';
import { threeTileMeshes } from '@vibeglobe/renderer/tiles3d';
import {
  google3dTiles,
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

/** The city's center (`CITY_CENTER` of the fixture), and Rome's for Google's tiles. */
const CITY = { longitudeDeg: 12.4922, latitudeDeg: 41.8902 };

/**
 * The Google logo and the copyrights of the drawn tiles (F470), updated every frame, its visibility pinned. Until
 * render extensions can add credits to the engine's attribution (hook request E (2)), the scenario shows them here.
 */
function googleCredits(globe: Globe, app: HTMLElement, extension: Tiles3DExtension): void {
  const element = document.createElement('div');
  element.className = 'vg-tiles3d-credits';
  const pin = 'display:block!important;visibility:visible!important;opacity:1!important;';
  element.style.cssText = `${pin}position:absolute;left:8px;top:8px;z-index:2147483647;font:11px sans-serif;color:#fff;background:#0009;padding:2px 4px;max-width:60%;`;
  const logo = document.createElement('span');
  logo.className = 'vg-tiles3d-logo';
  logo.textContent = 'Google';
  logo.style.cssText = `${pin}font-weight:bold;`;
  const text = document.createElement('span');
  text.className = 'vg-tiles3d-copyrights';
  element.append(logo, text);
  app.append(element);
  globe.on('frame', () => {
    const copyrights = extension.copyrights().join('; ');
    if (text.textContent !== copyrights) text.textContent = copyrights === '' ? '' : ` · ${copyrights}`;
  });
}

/** The scenario's message when Google's tiles cannot be configured; the rest of the globe keeps running (F468). */
function configurationMessage(app: HTMLElement, message: string): void {
  const element = document.createElement('div');
  element.className = 'vg-tiles3d-message';
  element.setAttribute('role', 'status');
  element.textContent = message;
  element.style.cssText =
    'position:absolute;left:8px;top:8px;right:8px;font:13px sans-serif;color:#fff;background:#a00c;padding:6px;';
  app.append(element);
}

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
    // Until the worker program registers parse-model (hook request E (1)), models decode with this table.
    modelTasks: createModelTasks({ draco: loadDraco3d(params.get('decoders') ?? dracoWasmUrl) }),
    ...(sse > 0 ? { maximumScreenSpaceError: sse } : {}),
    ...(budgetMb > 0 ? { memoryBudgetBytes: budgetMb * 1024 * 1024 } : {}),
  };
}

/** Google Photorealistic 3D Tiles for the URL; undefined (with the message shown) without a key. */
function googleOptions(params: URLSearchParams, app: HTMLElement): Tiles3DOptions | undefined {
  const apiKey = params.get('googleKey');
  if (!apiKey) {
    configurationMessage(
      app,
      'Google Photorealistic 3D Tiles need your own Map Tiles API key: open this page with ?googleKey=<key> ' +
        '(the key stays in your browser; never commit it).',
    );
    return undefined;
  }
  const google = google3dTiles({
    apiKey,
    billingRegion: params.get('googleRegion') === 'eea' ? 'eea' : 'other',
    ...(params.has('googleBase') ? { baseUrl: params.get('googleBase') ?? '' } : {}),
    ...(params.has('googleSessionMs') ? { sessionLifetimeMs: Number(params.get('googleSessionMs')) } : {}),
  });
  return {
    url: google.url,
    id: google.id,
    transport: google.transport,
    profile: google.profile,
    meshes: threeTileMeshes,
    modelTasks: createModelTasks({ draco: loadDraco3d(params.get('decoders') ?? dracoWasmUrl) }),
  };
}

/** Adds the scenario's tileset to the globe and frames the city unless the URL sets a view. */
export function showTiles3DScenario(
  globe: Globe,
  app: HTMLElement,
  params: URLSearchParams,
): Tiles3DTestHooks | undefined {
  const requests: RequestEvent[] = [];
  const picks: (Tiles3DPick | undefined)[] = [];
  const errors: string[] = [];
  let extension: Tiles3DExtension | undefined;
  const google = params.get('scenario') === '3dtiles-google';
  const options = google ? googleOptions(params, app) : tilesetOptions(params, import.meta.env.BASE_URL);
  if (!options) return undefined;
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
  if (google) googleCredits(globe, app, extension);
  const ext = extension;
  app.addEventListener('click', (event) => {
    const box = app.getBoundingClientRect();
    try {
      picks.push(ext.pick(event.clientX - box.left, event.clientY - box.top));
    } catch (error) {
      // Google's tiles are display only: picking them is refused (F323).
      errors.push(error instanceof Error ? error.message : String(error));
    }
  });
  const hooks: Tiles3DTestHooks = { extension: ext, requests, picks, errors };
  window.vibeglobeTiles3d = hooks;
  return hooks;
}
