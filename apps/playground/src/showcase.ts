// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The playground's UI (owner, 2026-10-25; `page-mode.ts` decides when): on every page the default controls of
 * `@vibeglobe/ui` (compass, zoom, tilt, 2D / 3D / Auto, home); on the showcase every control and tool of the package,
 * the settings panel and the help overlay over the space background, and the tour of the library's capabilities
 * (`tour/`), one scene at a time, its first scene the demo data layers. Loaded only when shown.
 */
import type { Globe } from '@vibeglobe/core';
import type { NavigationControls } from '@vibeglobe/controls';
import type { GlobeLayers } from '@vibeglobe/layers';
import type { SpaceBackground } from '@vibeglobe/renderer/starfield';
import type { ThemeName, Ui } from '@vibeglobe/ui';
import { HelpControl, SettingsControl, type ShowcaseHooks } from './showcase-panels.js';
import type { Shell } from './tour/shell.js';
import type { Tour } from './tour/tour.js';

/** The showcase's parts, for tests (`window.vibeglobeShowcase`). */
export interface ShowcaseHandle {
  readonly ui: Ui | undefined;
  readonly layers: GlobeLayers | undefined;
  space: SpaceBackground | undefined;
  /** The tour, on the showcase. */
  readonly tour: Tour | undefined;
}

/** The UI's language: `?lang=`, else the browser's when Italian, else English. */
function language(params: URLSearchParams): string {
  return params.get('lang') ?? (navigator.language.toLowerCase().startsWith('it') ? 'it' : 'en');
}

/** The UI's theme: `?theme=`, else the system's. */
function theme(params: URLSearchParams): ThemeName {
  const asked = params.get('theme');
  if (asked === 'dark' || asked === 'light') return asked;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** The default controls of every page. */
async function addPageControls(ui: Ui, navigation?: NavigationControls): Promise<void> {
  const { CompassControl, HomeControl, TiltControl, ViewModeControl, ZoomControl } = await import('@vibeglobe/ui');
  ui.add(new ViewModeControl({ position: 'top-left', ...(navigation ? { tilt: navigation } : {}) }));
  ui.add(new ZoomControl());
  ui.add(new CompassControl());
  ui.add(new TiltControl());
  ui.add(new HomeControl());
}

/** Every control and tool of the package, the settings and the help. */
async function addShowcaseControls(
  globe: Globe,
  ui: Ui,
  layers: GlobeLayers,
  hooks: ShowcaseHooks,
  navigation?: NavigationControls,
): Promise<void> {
  const m = await import('@vibeglobe/ui');
  const { MinimapControl } = await import('@vibeglobe/ui/minimap');
  const { demoGeocoder } = await import('./showcase-data.js');
  m.addAllControls(ui, {
    geocoder: demoGeocoder,
    layers: { dataLayers: layers },
    ...(navigation ? { tilt: navigation } : {}),
  });
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

/** The quality preset, the space background, the navigation mode and the theme, as the panels change them. */
function showcaseHooks(
  globe: Globe,
  handle: ShowcaseHandle,
  shell: () => Shell | undefined,
  navigation?: NavigationControls,
): ShowcaseHooks {
  let quality: { setPreset(preset: 'low' | 'medium' | 'high' | 'ultra'): void } | undefined;
  let adding: Promise<SpaceBackground> | undefined;
  const space = (): Promise<SpaceBackground> =>
    handle.space
      ? Promise.resolve(handle.space)
      : (adding ??= import('@vibeglobe/renderer/starfield').then(({ addSpaceBackground }) => {
          adding = undefined;
          return (handle.space ??= addSpaceBackground(globe));
        }));
  return {
    navigationMode: () => navigation?.navigationMode ?? 'free',
    setNavigationMode: (mode) => navigation?.setNavigationMode(mode),
    setQuality(preset) {
      if (quality) quality.setPreset(preset);
      else void import('@vibeglobe/quality').then(({ createQuality }) => (quality = createQuality(globe, { preset })));
    },
    setSpace(on) {
      if (on) return void space();
      handle.space?.remove();
      handle.space = undefined;
    },
    space,
    setTheme(next) {
      handle.ui?.setTheme(next);
      shell()?.setTheme(next);
      handle.ui?.get('showcase-settings')?.localize?.();
    },
  };
}

/** The tour's frame and the tour, from the fragment's scene. */
async function showTour(
  globe: Globe,
  container: HTMLElement,
  parts: { layers: GlobeLayers; ui: Ui | undefined; hooks: ShowcaseHooks; navigation: NavigationControls | undefined },
  setShell: (shell: Shell) => void,
): Promise<Tour> {
  let shell: Shell | undefined;
  if (parts.ui) {
    const { createShell } = await import('./tour/shell.js');
    shell = createShell(container, parts.ui.theme, parts.hooks.setTheme);
    shell.setBackend(globe.backend === 'webgpu' ? 'WebGPU' : 'WebGL2');
    setShell(shell);
  }
  const { startTour } = await import('./tour/tour.js');
  return startTour({ globe, container, shell, ...parts });
}

/**
 * Shows the page's UI once the globe is ready: on the showcase every control, the space background and the tour,
 * else the default controls; no controls when `ui` is false (the showcase's tour still shows its scene's data).
 */
export async function showPageUi(
  globe: Globe,
  container: HTMLElement,
  params: URLSearchParams,
  { showcase, ui: withUi, navigation }: { showcase: boolean; ui: boolean; navigation?: NavigationControls },
): Promise<ShowcaseHandle> {
  await globe.ready;
  const handle: { -readonly [K in keyof ShowcaseHandle]: ShowcaseHandle[K] } = {
    ui: undefined,
    layers: undefined,
    space: undefined,
    tour: undefined,
  };
  let shell: Shell | undefined;
  const hooks = showcaseHooks(globe, handle, () => shell, navigation);
  if (showcase) {
    const { createGlobeLayers } = await import('@vibeglobe/layers');
    handle.layers = createGlobeLayers(globe, { element: container });
    hooks.setSpace(true);
    // The atmosphere the settings panel starts with.
    globe.setQualitySettings({ atmosphere: 'high' });
  }
  if (withUi) {
    // The readout and the attribution control take the place of the page's own status and cursor lines.
    for (const id of ['#status', '#cursor'])
      document.querySelector<HTMLElement>(id)?.style.setProperty('display', 'none');
    const { createUi } = await import('@vibeglobe/ui');
    handle.ui = createUi(globe, container, {
      language: language(params),
      theme: theme(params),
      ...(handle.layers ? { layers: handle.layers } : {}),
    });
    if (showcase && handle.layers) await addShowcaseControls(globe, handle.ui, handle.layers, hooks, navigation);
    else await addPageControls(handle.ui, navigation);
  }
  if (showcase && handle.layers)
    handle.tour = await showTour(
      globe,
      container,
      { layers: handle.layers, ui: handle.ui, hooks, navigation },
      (made) => (shell = made),
    );
  window.vibeglobeShowcase = handle;
  return handle;
}

declare global {
  interface Window {
    /** `apps/playground/src/showcase.ts`. */
    vibeglobeShowcase?: ShowcaseHandle;
  }
}
