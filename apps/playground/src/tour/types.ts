// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The showcase tour's shapes: chapters of scenes, each scene a module loaded on demand that builds its live controls
 * in the panel and undoes everything it added when the visitor leaves.
 */
import type { NavigationControls } from '@vibeglobe/controls';
import type { Globe, GlobeEvents, ImageryLayerInput, ViewInit } from '@vibeglobe/core';
import type { GlobeLayers, Layer } from '@vibeglobe/layers';
import type { Ui } from '@vibeglobe/ui';
import type { ShowcaseHooks } from '../showcase-panels.js';
import type { Panel } from './panel.js';

/** The chapters, in the order of the rail. */
export type ChapterId =
  | 'earth'
  | 'views'
  | 'imagery'
  | 'terrain'
  | 'vector'
  | 'data'
  | 'models'
  | 'tools'
  | 'offline'
  | 'performance'
  | 'integrations';

/** The terrain a scene needs: chosen when the globe is created, so a change reloads the page. */
export type TourTerrain = 'terrarium' | 'mapterhorn';

/** A scene in the catalog: what the rail and the panel show before its module loads. */
export interface SceneEntry {
  readonly id: string;
  readonly chapter: ChapterId;
  readonly title: string;
  /** One or two sentences: what the scene shows. */
  readonly summary: string;
  /** The guide that explains it: a file of `docs/guides/` with an optional anchor, or a repository path. */
  readonly guide: string;
  readonly terrain?: TourTerrain;
  /** What the scene loads from the network: the scene waits for the visitor's consent. */
  readonly online?: string;
  load(): Promise<SceneModule>;
}

/** A scene's implementation. */
export interface SceneModule {
  /** A short example of the API the scene uses. */
  readonly code: string;
  start(context: SceneContext): void | Promise<void>;
}

/** What a scene works with; everything added through it is removed when the scene is left. */
export interface SceneContext {
  readonly globe: Globe;
  readonly layers: GlobeLayers;
  /** The globe's container. */
  readonly container: HTMLElement;
  readonly navigation: NavigationControls | undefined;
  readonly ui: Ui | undefined;
  readonly hooks: ShowcaseHooks;
  /** The scene's live controls. */
  readonly panel: Panel;
  /** Aborted when the scene is left. */
  readonly signal: AbortSignal;
  /** Runs `cleanup` when the scene is left (last registered first). */
  defer(cleanup: () => void): void;
  /** Adds a data layer to the shared stack until the scene is left. */
  add<L extends Layer>(layer: L): L;
  /** Adds an imagery layer on top until the scene is left. */
  imagery(layer: ImageryLayerInput): void;
  /** Subscribes to a globe event until the scene is left. */
  on<E extends keyof GlobeEvents>(event: E, handler: (payload: GlobeEvents[E]) => void): void;
  /** Moves to the scene's view: at once on the page's first scene, by a flight otherwise. */
  go(view: ViewInit): void;
}
