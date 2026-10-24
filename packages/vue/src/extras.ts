// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { Globe } from '@vibeglobe/core';
import type { GlobeLayers } from '@vibeglobe/layers';
import type { Ui } from '@vibeglobe/ui';
import type { GlobeExtras } from './context.js';

/**
 * The data layers and UI layer of one globe, created on first use after the engine is ready; the packages load only
 * then, so a globe without child components loads neither. `release` detaches and destroys what was created.
 */
export function globeExtras(
  globe: () => Globe | undefined,
  container: () => HTMLElement | undefined,
): GlobeExtras & { release(): void } {
  let layers: Promise<GlobeLayers> | undefined;
  let ui: Promise<Ui> | undefined;
  let created: { layers?: GlobeLayers; ui?: Ui } = {};
  const engine = (): Globe => {
    const current = globe();
    if (current === undefined) throw new Error('The globe is not running');
    return current;
  };
  const extras = {
    layers: () =>
      (layers ??= engine().ready.then(async () => {
        const { createGlobeLayers } = await import('@vibeglobe/layers');
        const element = container();
        created.layers = createGlobeLayers(engine(), element ? { element } : {});
        return created.layers;
      })),
    ui: () =>
      (ui ??= extras.layers().then(async (shared) => {
        const { createUi } = await import('@vibeglobe/ui');
        const element = container();
        if (element === undefined) throw new Error('The globe is not mounted');
        created.ui = createUi(engine(), element, { layers: shared });
        return created.ui;
      })),
    release: () => {
      created.ui?.destroy();
      created.layers?.detach();
      created.layers?.stack.clear();
      created = {};
      layers = undefined;
      ui = undefined;
    },
  };
  return extras;
}
