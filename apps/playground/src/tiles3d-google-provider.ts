/**
 * The `3dtiles-google` scenario's Google parts (F468–F470), in a module of its own so the other 3D Tiles scenarios
 * carry no Google code (F344: only `*-provider*` modules name restricted hosts): the adapter from the URL's key, and
 * Google's logo with the copyrights of the drawn tiles.
 */
import type { Globe } from '@vibeglobe/core';
import { threeTileMeshes } from '@vibeglobe/renderer/tiles3d';
import { google3dTiles, type Tiles3DExtension, type Tiles3DOptions } from '@vibeglobe/sources/tiles3d';

/**
 * The Google logo and the copyrights of the drawn tiles (F470), updated every frame, its visibility pinned. Until
 * render extensions can add credits to the engine's attribution (hook request E (2)), the scenario shows them here.
 */
function showCredits(globe: Globe, app: HTMLElement, extension: Tiles3DExtension): void {
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

/** Google Photorealistic 3D Tiles for the URL; without a key, a configuration message and no options. */
export function googleScenario(
  params: URLSearchParams,
  app: HTMLElement,
): { options: Tiles3DOptions | undefined; showCredits(globe: Globe, extension: Tiles3DExtension): void } {
  const apiKey = params.get('googleKey');
  const credits = (globe: Globe, extension: Tiles3DExtension): void => showCredits(globe, app, extension);
  if (!apiKey) {
    configurationMessage(
      app,
      'Google Photorealistic 3D Tiles need your own Map Tiles API key: open this page with ?googleKey=<key> ' +
        '(the key stays in your browser; never commit it).',
    );
    return { options: undefined, showCredits: credits };
  }
  let google: ReturnType<typeof google3dTiles>;
  try {
    google = google3dTiles({
      apiKey,
      billingRegion: params.get('googleRegion') === 'eea' ? 'eea' : 'other',
      ...(params.has('googleBase') ? { baseUrl: params.get('googleBase') ?? '' } : {}),
      ...(params.has('googleSessionMs') ? { sessionLifetimeMs: Number(params.get('googleSessionMs')) } : {}),
    });
  } catch (error) {
    // An EEA billing account does not get Photorealistic 3D Tiles (ADR 0031): say so, and keep the engine running.
    configurationMessage(app, error instanceof Error ? error.message : String(error));
    return { options: undefined, showCredits: credits };
  }
  return {
    options: {
      url: google.url,
      id: google.id,
      transport: google.transport,
      profile: google.profile,
      meshes: threeTileMeshes,
    },
    showCredits: credits,
  };
}
