// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { createControls, type ControlsOptions } from '@vibeglobe/controls';
import {
  createGlobe,
  GlobeError,
  type GeocoderService,
  type Globe,
  type GlobeOptions,
  type TileService,
} from '@vibeglobe/core';
import { createRenderer } from '@vibeglobe/renderer';
import { addDefaultControls, createUi, type Ui } from '@vibeglobe/ui';
import { createWorkers } from '@vibeglobe/worker';

/** Options of {@link createVibeGlobe}: the services, then any engine option (`terrain`, `view`, `quality`, …). */
export interface VibeGlobeOptions extends Omit<
  GlobeOptions,
  'container' | 'renderer' | 'controls' | 'baseImageryUrl' | 'imagery' | 'workers'
> {
  /** Where the map's tiles come from: required. */
  readonly tiles: TileService;
  /** Place search; without it the search box accepts coordinates only. */
  readonly geocoder?: GeocoderService;
  /** An equirectangular image of the whole world, shown where no tile is loaded yet (default: one ocean color). */
  readonly baseImageryUrl?: string;
  /** Mouse, touch and keyboard navigation options, or false for none. */
  readonly controls?: ControlsOptions | false;
  /** The ready-made controls (search, zoom, compass, fullscreen, coordinates); false for none. */
  readonly ui?: boolean;
  /** The language of the controls and of the map's names, such as 'it' (default English). */
  readonly language?: string;
}

/** A started globe: the engine and its ready-made controls. */
export interface VibeGlobe {
  readonly globe: Globe;
  /** The ready-made controls; undefined with `ui: false`. */
  readonly ui: Ui | undefined;
  /** Stops the globe and removes its controls and canvas. */
  destroy(): void;
}

/** A 1×1 ocean-blue image: the world under the tiles while none is loaded, without an asset to host. */
const OCEAN =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOQsY8BAAEyALi+BX15AAAAAElFTkSuQmCC';

/**
 * Starts VibeGlobe in `container` with the application's services (ADR 0186): the tiles, required, and optionally a
 * terrain and a geocoder. Resolves once the first frame is drawn and the tile service's style, if any, is attached;
 * rejects with a `GlobeError` (everything stopped) without tiles, on a device without WebGPU or WebGL2, or when the
 * style does not load.
 */
export async function createVibeGlobe(container: HTMLElement, options: VibeGlobeOptions): Promise<VibeGlobe> {
  const { tiles, geocoder, controls, ui: withUi = true, language, baseImageryUrl = OCEAN, ...engine } = options;
  if (!tiles) throw new GlobeError('invalid-option', 'createVibeGlobe needs a tile service: { tiles }');
  const globe = createGlobe({
    ...engine,
    container,
    renderer: createRenderer(),
    ...(controls === false ? {} : { controls: createControls(controls) }),
    baseImageryUrl,
    imagery: tiles.imagery,
    workers: createWorkers(),
  });
  const ui = withUi ? createUi(globe, container, language ? { language } : {}) : undefined;
  if (ui) addDefaultControls(ui, geocoder ? { geocoder } : {});
  let layer: { remove(): void } | undefined;
  const destroy = (): void => {
    layer?.remove();
    ui?.destroy();
    globe.destroy();
  };
  try {
    await globe.ready;
    if (tiles.style) {
      const [{ addVectorTiles }, { createVectorTileTarget }] = await Promise.all([
        import('@vibeglobe/layers/vector-tiles'),
        import('@vibeglobe/renderer/vector-tiles'),
      ]);
      const vector = await addVectorTiles(globe, {
        style: tiles.style,
        target: createVectorTileTarget,
        element: container,
      });
      if (language) vector.setLanguage(language);
      layer = vector;
    }
  } catch (cause) {
    destroy();
    throw cause instanceof GlobeError
      ? cause
      : new GlobeError('resource-failed', 'The map style did not load', { cause });
  }
  return { globe, ui, destroy };
}
