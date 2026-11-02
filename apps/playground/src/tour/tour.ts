// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The showcase tour: the scene in the page's fragment (`#scene=<id>`, so the page mode, read from the query, stays as
 * it is) loads its module, builds its controls and moves the camera; leaving it undoes what it added. A scene that
 * needs another terrain reloads the page with it, since terrain is chosen when the globe is created; a scene that
 * reads the network waits for the visitor's consent. `#view=` in the fragment (`@vibeglobe/gis`) sets the view.
 */
import type { NavigationControls } from '@vibeglobe/controls';
import type { Globe, ViewInit } from '@vibeglobe/core';
import type { GlobeLayers } from '@vibeglobe/layers';
import type { Ui } from '@vibeglobe/ui';
import type { ShowcaseHooks } from '../showcase-panels.js';
import { DEFAULT_SCENE, SCENES } from './catalog.js';
import { button, createPanel, element } from './panel.js';
import type { Shell } from './shell.js';
import type { SceneContext, SceneEntry, TourTerrain } from './types.js';

/** What the tour runs on. */
export interface TourBase {
  readonly globe: Globe;
  readonly layers: GlobeLayers;
  readonly container: HTMLElement;
  readonly navigation: NavigationControls | undefined;
  readonly ui: Ui | undefined;
  readonly hooks: ShowcaseHooks;
  /** The frame, when the page shows the UI. */
  readonly shell: Shell | undefined;
}

/** The tour's state, for tests (`window.vibeglobeShowcase.tour`). */
export interface Tour {
  /** The scene shown, once its start has finished; undefined while one loads. */
  readonly scene: string | undefined;
}

const TERRAINS: ReadonlySet<string> = new Set<TourTerrain>(['terrarium', 'mapterhorn']);

/** The scene the fragment names, or the first scene. */
function sceneOfHash(): SceneEntry {
  const id = new URLSearchParams(location.hash.slice(1)).get('scene') ?? DEFAULT_SCENE;
  return SCENES.find((scene) => scene.id === id) ?? (SCENES.find((scene) => scene.id === DEFAULT_SCENE) as SceneEntry);
}

/** The tour terrain the page's globe was created with. */
function pageTerrain(): string | undefined {
  const terrain = new URLSearchParams(location.search).get('terrain') ?? '';
  return TERRAINS.has(terrain) ? terrain : undefined;
}

/** Reloads the page on the scene with its terrain, keeping the UI's theme and language. */
function reload(entry: SceneEntry, ui: Ui | undefined): void {
  const next = new URLSearchParams(location.search);
  next.set('showcase', '1');
  if (entry.terrain) next.set('terrain', entry.terrain);
  else next.delete('terrain');
  if (ui) {
    next.set('theme', ui.theme);
    next.set('lang', ui.i18n.language);
  }
  location.assign(`${location.pathname}?${next.toString()}#scene=${entry.id}`);
}

/** The context of one visit to a scene; `leave` undoes everything added through it. */
function sceneContext(base: TourBase, body: HTMLElement, first: boolean): { context: SceneContext; leave(): void } {
  const { globe, layers } = base;
  const controller = new AbortController();
  const cleanups: (() => void)[] = [];
  const defer = (cleanup: () => void): void => void cleanups.push(cleanup);
  const context: SceneContext = {
    ...base,
    panel: createPanel(body),
    signal: controller.signal,
    defer,
    add(layer) {
      layers.stack.add(layer);
      defer(() => layers.stack.get(layer.id) === layer && layers.stack.remove(layer));
      return layer;
    },
    imagery(layer) {
      globe.imageryLayers.add(layer);
      const id = 'sources' in layer ? (layer.id ?? layer.sources[0]?.id) : layer.id;
      defer(() => id !== undefined && globe.imageryLayers.remove(id));
    },
    on: (event, handler) => defer(globe.on(event, handler)),
    go(view: ViewInit) {
      // The page's first scene keeps a view the URL gives (`?lon=` or `#view=`).
      if (first && (location.hash.includes('view=') || new URLSearchParams(location.search).has('lon'))) return;
      if (!first) return void globe.flyTo(view, { signal: controller.signal });
      // The tilt is chosen a frame later, from the view's own distance: a tilt policy judges a jump's tilt from the
      // distance of the frame before, and from afar it would return the view to Auto.
      const { tiltDeg, ...place } = view;
      globe.jumpTo(place);
      if (!tiltDeg) return;
      const off = globe.on('frame', () => {
        off();
        if (!controller.signal.aborted) globe.jumpTo({ tiltDeg });
      });
      defer(off);
    },
  };
  const leave = (): void => {
    controller.abort();
    for (const cleanup of cleanups.reverse()) cleanup();
  };
  return { context, leave };
}

/** The consent card of a scene that reads the network. */
function consent(body: HTMLElement, entry: SceneEntry, accept: () => void): void {
  const card = element('div', 'tour-online');
  card.append(
    element('p', '', `This scene loads ${entry.online ?? 'data'} from the internet.`),
    element('p', 'tour-note', 'Every other scene runs on the data bundled with the playground.'),
    button('Load online data', accept, 'tour-button tour-button--primary'),
  );
  body.append(card);
}

/** Applies a `#view=` of the page's address once, after the first scene placed its own view. */
async function applyUrlView(globe: Globe): Promise<void> {
  if (!location.hash.includes('view=')) return;
  const [{ viewStateFromUrl }, { applyViewState }] = await Promise.all([
    import('@vibeglobe/gis'),
    import('@vibeglobe/ui'),
  ]);
  const view = viewStateFromUrl(location.href);
  if (view) applyViewState(globe, view);
}

/** Starts the tour on the fragment's scene and follows the fragment from then on. */
export async function startTour(base: TourBase): Promise<Tour> {
  const tour = { scene: undefined as string | undefined };
  const consented = new Set<string>();
  let visit = 0;
  let leave: (() => void) | undefined;
  const run = async (entry: SceneEntry, first: boolean): Promise<void> => {
    const ticket = ++visit;
    leave?.();
    leave = undefined;
    tour.scene = undefined;
    const body = base.shell?.body ?? element('div');
    base.shell?.show(entry);
    // A page created with the scene's online terrain was reloaded after the visitor's consent.
    const loaded = entry.terrain !== undefined && entry.terrain === pageTerrain();
    if (entry.online && !loaded && !consented.has(entry.id)) {
      if (base.shell) consent(body, entry, () => (consented.add(entry.id), void run(entry, false)));
      return;
    }
    if (entry.terrain !== pageTerrain()) return reload(entry, base.ui);
    base.shell?.status('Loading…');
    try {
      const scene = await entry.load();
      if (ticket !== visit) return;
      base.shell?.code(scene.code);
      const visitOf = sceneContext(base, body, first);
      leave = visitOf.leave;
      await scene.start(visitOf.context);
      if (ticket !== visit) return;
      base.shell?.status(undefined);
      tour.scene = entry.id;
    } catch (error) {
      if (ticket !== visit) return;
      console.warn(`[showcase] scene ${entry.id}:`, error);
      base.shell?.status(`This scene could not start: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  };
  window.addEventListener('hashchange', () => {
    if (new URLSearchParams(location.hash.slice(1)).get('scene') !== tour.scene) void run(sceneOfHash(), false);
  });
  await run(sceneOfHash(), true);
  await applyUrlView(base.globe);
  return tour;
}
