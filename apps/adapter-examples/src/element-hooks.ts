import type { VibeGlobeElement } from '@vibeglobe/web-component';
import type { ExampleEvent, ExampleHooks } from './hooks.js';

/** The element's events that the example pages record. */
export const ELEMENT_EVENTS = ['ready', 'load', 'camera-change', 'globe-click', 'error'] as const;

/** Test hooks for a page whose framework renders `<vibe-globe>` elements. */
export function elementHooks(events: ExampleEvent[], show: (shown: boolean) => Promise<void>): ExampleHooks {
  const elements = (): VibeGlobeElement[] => [...document.querySelectorAll<VibeGlobeElement>('vibe-globe')];
  return {
    events,
    globes: () => elements().map((element) => element.globe),
    show,
    async setView(view) {
      const element = elements()[0];
      if (!element) return;
      if (view.longitudeDeg !== undefined && view.latitudeDeg !== undefined)
        element.center = { longitudeDeg: view.longitudeDeg, latitudeDeg: view.latitudeDeg };
      if (view.zoom !== undefined) element.zoom = view.zoom;
    },
  };
}
