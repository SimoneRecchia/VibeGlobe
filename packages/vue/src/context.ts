import type { Globe } from '@vibeglobe/core';
import type { GlobeLayers } from '@vibeglobe/layers';
import type { Ui } from '@vibeglobe/ui';
import type { InjectionKey, ShallowRef } from 'vue';

/** The engine of the nearest enclosing globe component, undefined until it starts and after it unmounts. */
export const GLOBE_KEY: InjectionKey<ShallowRef<Globe | undefined>> = Symbol('vibeglobe');

/** What a globe component offers its child components: its data layers and its UI layer, created on first use. */
export interface GlobeExtras {
  /** The globe's data-layer stack (`@vibeglobe/layers`, loaded on first use), after the engine is ready. */
  layers(): Promise<GlobeLayers>;
  /** The globe's UI layer (`@vibeglobe/ui`, loaded on first use), sharing the data layers. */
  ui(): Promise<Ui>;
}

/** The extras of the nearest enclosing globe component. */
export const EXTRAS_KEY: InjectionKey<GlobeExtras> = Symbol('vibeglobe-extras');
