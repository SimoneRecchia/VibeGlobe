// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The playground's UI (owner, 2026-10-25; `page-mode.ts` decides when): on every page the default controls of
 * `@vibeglobe/ui` (compass, zoom, tilt, 2D / 3D / Auto, home); on the showcase every control and tool of the package,
 * the settings panel and the help overlay, over the demo data layers and the space background. Loaded only when shown.
 */
import type { Globe } from '@vibeglobe/core';
import type { GlobeLayers } from '@vibeglobe/layers';
import type { SpaceBackground } from '@vibeglobe/renderer/starfield';
import type { Ui } from '@vibeglobe/ui';
import { HelpControl, SettingsControl, type ShowcaseHooks } from './showcase-panels.js';

/** The showcase's parts, for tests (`window.vibeglobeShowcase`). */
export interface ShowcaseHandle {
  readonly ui: Ui | undefined;
  readonly layers: GlobeLayers | undefined;
  space: SpaceBackground | undefined;
}

/** The UI's language: `?lang=`, else the browser's when Italian, else English. */
function language(params: URLSearchParams): string {
  return params.get('lang') ?? (navigator.language.toLowerCase().startsWith('it') ? 'it' : 'en');
}

/** The default controls of every page. */
async function addPageControls(ui: Ui): Promise<void> {
  const { CompassControl, HomeControl, TiltControl, ViewModeControl, ZoomControl } = await import('@vibeglobe/ui');
  ui.add(new ViewModeControl({ position: 'top-left' }));
  ui.add(new ZoomControl());
  ui.add(new CompassControl());
  ui.add(new TiltControl());
  ui.add(new HomeControl());
}

/** Every control and tool of the package, the settings and the help. */
async function addShowcaseControls(globe: Globe, ui: Ui, layers: GlobeLayers, hooks: ShowcaseHooks): Promise<void> {
  const m = await import('@vibeglobe/ui');
  const { MinimapControl } = await import('@vibeglobe/ui/minimap');
  const { demoGeocoder } = await import('./showcase-data.js');
  m.addAllControls(ui, { geocoder: demoGeocoder, layers: { dataLayers: layers } });
  // The readout with the elevation under the pointer, from the terrain drawn.
  ui.replace(
    new m.CoordinateReadoutControl({
      elevationAt: (position) => {
        const sample = globe.elevationAt(position);
        return sample.noData ? undefined : sample.heightMeters;
      },
    }),
  );
  ui.add(new m.MeasureControl());
  ui.add(new m.DrawControl());
  ui.add(new m.BookmarksControl());
  ui.add(new m.ScreenshotControl());
  ui.add(new MinimapControl({ imageUrl: `${import.meta.env.BASE_URL}imagery/natural-earth-4096.jpg` }));
  ui.add(new SettingsControl(() => ui, hooks));
  ui.add(new HelpControl());
}

/** The quality preset and the space background, as the settings panel changes them. */
function showcaseHooks(globe: Globe, handle: ShowcaseHandle): ShowcaseHooks {
  let quality: { setPreset(preset: 'low' | 'medium' | 'high' | 'ultra'): void } | undefined;
  return {
    setQuality(preset) {
      if (quality) quality.setPreset(preset);
      else void import('@vibeglobe/quality').then(({ createQuality }) => (quality = createQuality(globe, { preset })));
    },
    setSpace(on) {
      if (!on) {
        handle.space?.remove();
        handle.space = undefined;
      } else if (!handle.space)
        void import('@vibeglobe/renderer/starfield').then(({ addSpaceBackground }) => {
          handle.space ??= addSpaceBackground(globe);
        });
    },
  };
}

/**
 * Shows the page's UI once the globe is ready: the showcase's data, space background and every control when
 * `showcase`, else the default controls; no controls when `ui` is false.
 */
export async function showPageUi(
  globe: Globe,
  container: HTMLElement,
  params: URLSearchParams,
  { showcase, ui: withUi }: { showcase: boolean; ui: boolean },
): Promise<ShowcaseHandle> {
  await globe.ready;
  let layers: GlobeLayers | undefined;
  const handle: ShowcaseHandle = { ui: undefined, layers: undefined, space: undefined };
  const hooks = showcaseHooks(globe, handle);
  if (showcase) {
    const { createGlobeLayers } = await import('@vibeglobe/layers');
    layers = createGlobeLayers(globe, { element: container });
    await (await import('./showcase-data.js')).addDemoLayers(globe, layers);
    hooks.setSpace(true);
  }
  let ui: Ui | undefined;
  if (withUi) {
    // The readout and the attribution control take the place of the page's own status and cursor lines.
    for (const id of ['#status', '#cursor'])
      document.querySelector<HTMLElement>(id)?.style.setProperty('display', 'none');
    const { createUi } = await import('@vibeglobe/ui');
    ui = createUi(globe, container, {
      language: language(params),
      theme: params.get('theme') === 'dark' ? 'dark' : 'light',
      ...(layers ? { layers } : {}),
    });
    if (showcase && layers) await addShowcaseControls(globe, ui, layers, hooks);
    else await addPageControls(ui);
  }
  const shown: ShowcaseHandle = Object.assign(handle, { ui, layers });
  window.vibeglobeShowcase = shown;
  return shown;
}

declare global {
  interface Window {
    /** `apps/playground/src/showcase.ts`. */
    vibeglobeShowcase?: ShowcaseHandle;
  }
}
