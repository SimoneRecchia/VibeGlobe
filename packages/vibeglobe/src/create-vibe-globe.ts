// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { createControls, type ControlsOptions } from '@vibeglobe/controls';
import {
  createGlobe,
  GlobeError,
  type GeocoderService,
  type Globe,
  type GlobeOptions,
  type TerrainService,
  type TileService,
} from '@vibeglobe/core';
import { createRenderer, type BackendChoice } from '@vibeglobe/renderer';
import { addAllControls, addDefaultControls, createUi, type Ui } from '@vibeglobe/ui';
import { createWorkers } from '@vibeglobe/worker';

/** Options of {@link createVibeGlobe}: the services, then any engine option (`view`, `quality`, `constraints`, …). */
export interface VibeGlobeOptions extends Omit<
  GlobeOptions,
  'container' | 'renderer' | 'controls' | 'baseImageryUrl' | 'imagery' | 'terrain' | 'workers'
> {
  /** Where the map's tiles come from: required. */
  readonly tiles: TileService;
  /** The relief of the 3D view; without it the surface is flat. */
  readonly terrain?: TerrainService;
  /** Place search; without it the search box accepts coordinates only. */
  readonly geocoder?: GeocoderService;
  /** An equirectangular image of the whole world, shown where no tile is loaded yet (default: one ocean color). */
  readonly baseImageryUrl?: string;
  /** 'auto' (default: WebGPU, else WebGL2), 'webgpu' or 'webgl2'. */
  readonly backend?: BackendChoice;
  /** Mouse, touch and keyboard navigation: true (default), these options, or false for none. */
  readonly controls?: boolean | ControlsOptions;
  /** The ready-made controls: 'default' (search, zoom, compass, fullscreen, coordinates), 'all', or false for none. */
  readonly ui?: 'default' | 'all' | false;
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
 * Starts VibeGlobe in `container` with the application's services (ADR 0186): the tiles, required, and optionally the
 * terrain and a geocoder; the features of a missing optional service are off. Resolves once the first frame is drawn
 * and the tile service's style, if any, is attached; rejects with a `GlobeError` (everything stopped) when the device
 * can draw neither WebGPU nor WebGL2, the tile service is missing, or its style does not load.
 */
export async function createVibeGlobe(container: HTMLElement, options: VibeGlobeOptions): Promise<VibeGlobe> {
  const { tiles, terrain, geocoder, backend, controls, ui: uiKind, language, baseImageryUrl, ...engine } = options;
  if (typeof tiles?.imagery !== 'function')
    throw new GlobeError('invalid-option', 'createVibeGlobe needs a tile service: { tiles: new MyTiles() }');
  const navigation = controls === false ? undefined : createControls(controls === true ? undefined : controls);
  const globe = createGlobe({
    ...(uiKind === 'all' ? { creditsElement: false } : {}),
    ...engine,
    container,
    renderer: createRenderer({ backend: backend ?? 'auto' }),
    ...(navigation ? { controls: navigation } : {}),
    baseImageryUrl: baseImageryUrl ?? OCEAN,
    imagery: tiles.imagery(),
    ...(terrain ? { terrain: terrain.terrain() } : {}),
    workers: createWorkers(),
  });
  const ui = uiKind === false ? undefined : createUi(globe, container, language ? { language } : {});
  if (ui) (uiKind === 'all' ? addAllControls : addDefaultControls)(ui, geocoder ? { geocoder } : {});
  const stops: (() => void)[] = [];
  const destroy = (): void => {
    for (const stop of stops) stop();
    ui?.destroy();
    globe.destroy();
  };
  try {
    await globe.ready;
    const style = tiles.style?.();
    if (style !== undefined) {
      const [{ addVectorTiles }, { createVectorTileTarget }] = await Promise.all([
        import('@vibeglobe/layers/vector-tiles'),
        import('@vibeglobe/renderer/vector-tiles'),
      ]);
      const transformUrl = tiles.transformUrl?.bind(tiles);
      const layer = await addVectorTiles(globe, {
        style,
        target: createVectorTileTarget,
        element: container,
        ...(transformUrl ? { transformUrl } : {}),
      });
      if (language) layer.setLanguage(language);
      stops.push(() => layer.remove());
    }
  } catch (cause) {
    destroy();
    throw cause instanceof GlobeError
      ? cause
      : new GlobeError('resource-failed', 'The map style did not load', { cause });
  }
  return { globe, ui, destroy };
}
