// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * `?preset=europe`: the Europe preset of free map types (`@vibeglobe/presets`, ADR 0182) with a selector of its base
 * maps and overlays (F617), online only. `&presetBase=satellite|hybrid|map|relief` and `&presetOverlays=labels,roads,…`
 * set the start; `&presetStyle=<url>` replaces OpenFreeMap's style (tests use the fixture streets style, in the same
 * OpenMapTiles schema); `&presetExclude=<id>,…` leaves sources out. 3D terrain is chosen when the globe is created, so
 * switching it reloads the page. Hooks in `window.vibeglobeEuropePreset`.
 */
import type { Globe, GlobeOptions } from '@vibeglobe/core';
import type { VectorTileLayer } from '@vibeglobe/layers/vector-tiles';
import { type BaseMap, europeOpen, type Overlay, type StyleJson } from '@vibeglobe/presets';
import { createWorkers } from '@vibeglobe/worker';

const params = new URLSearchParams(location.search);
const enabled = params.get('preset') === 'europe';
const preset = enabled
  ? europeOpen({ exclude: (params.get('presetExclude') ?? '').split(',').filter((id) => id !== '') })
  : undefined;
const startOverlays = (params.get('presetOverlays') ?? '').split(',').filter((id) => id !== '') as Overlay['id'][];

const startBase = (params.get('presetBase') ?? 'satellite') as BaseMap['id'];

/**
 * The globe's options of the preset: the start base map's imagery (layers are added and removed at runtime on a globe
 * started with imagery), its 3D terrain when asked for, and the workers its sources decode with.
 */
export const europeLayers: Pick<GlobeOptions, 'imagery' | 'terrain' | 'workers'> =
  preset === undefined
    ? {}
    : {
        workers: createWorkers(),
        // A start on Map or Relief starts the satellite layers hidden, so the globe can show them later.
        imagery:
          (preset.baseMaps.find((b) => b.id === startBase)?.imagery.length ?? 0)
            ? (preset.baseMaps.find((b) => b.id === startBase)?.imagery ?? [])
            : (preset.baseMaps[0]?.imagery ?? []).map((layer) => ({ ...layer, visible: false })),
        ...(startOverlays.includes('terrain') && preset.terrain ? { terrain: preset.terrain } : {}),
      };

/** What the selector shows, for tests. */
interface EuropePresetHooks {
  readonly base: BaseMap['id'];
  readonly overlays: readonly Overlay['id'][];
  /** Resolves once the selection is drawn (its style loaded). */
  select(base: BaseMap['id'], overlays: readonly Overlay['id'][]): Promise<void>;
}

/** Shows the selector and the start selection, once the globe is ready. */
export async function showEuropePreset(globe: Globe, container: HTMLElement): Promise<void> {
  if (!preset) return;
  await globe.ready;
  const { addVectorTiles } = await import('@vibeglobe/layers/vector-tiles');
  const { createVectorTileTarget } = await import('@vibeglobe/renderer/vector-tiles');
  const styleUrl = params.get('presetStyle') ?? preset.styleUrl('online');
  const style = (await (await fetch(styleUrl)).json()) as StyleJson;
  let vectors: VectorTileLayer | undefined;
  const hooks = {
    base: startBase,
    overlays: startOverlays,
    async select(base: BaseMap['id'], overlays: readonly Overlay['id'][]): Promise<void> {
      if (overlays.includes('terrain') !== hooks.overlays.includes('terrain')) {
        // The terrain is chosen when the globe is created.
        const next = new URLSearchParams(location.search);
        next.set('presetBase', base);
        next.set('presetOverlays', overlays.join(','));
        location.search = next.toString();
        return;
      }
      hooks.base = base;
      hooks.overlays = [...overlays];
      // Map and Relief fill the polar caps with their own colors; Satellite and Hybrid's Blue Marble covers them.
      globe.setPolarCapColors(
        preset.baseMaps.find((b) => b.id === base)?.polarCapColors ?? { north: '#78a9cd', south: '#f2f3f7' },
      );
      // The base map's imagery layers, by id: Satellite and Hybrid share theirs.
      const wanted = preset.baseMaps.find((b) => b.id === base)?.imagery ?? [];
      for (const layer of globe.imageryLayers.list())
        if (!wanted.some((w) => w.id === layer.id)) globe.imageryLayers.remove(layer.id);
      for (const layer of wanted)
        if (!globe.imageryLayers.list().some((l) => l.id === layer.id)) globe.imageryLayers.add(layer);
      vectors?.remove();
      vectors = undefined;
      const composed = preset.styleFor(style, base, overlays);
      if (composed)
        vectors = await addVectorTiles(globe, {
          style: composed,
          target: createVectorTileTarget,
          element: container,
          localFontFamily: 'sans-serif',
        });
      globe.requestRender();
    },
    get layer(): VectorTileLayer | undefined {
      return vectors;
    },
  };
  (window as unknown as { vibeglobeEuropePreset: EuropePresetHooks }).vibeglobeEuropePreset = hooks;
  container.append(selector(hooks));
  await hooks.select(hooks.base, hooks.overlays);
}

/** The selector: one choice of base map, any overlays. */
function selector(hooks: EuropePresetHooks): HTMLElement {
  const panel = document.createElement('form');
  panel.className = 'europe-preset';
  panel.style.cssText =
    'position:absolute;top:8px;right:8px;z-index:2;background:#fffe;padding:8px 10px;font:13px sans-serif;border-radius:4px';
  panel.setAttribute('aria-label', 'Europe map types');
  const changed = (): void => {
    const data = new FormData(panel);
    void hooks.select(String(data.get('base')) as BaseMap['id'], data.getAll('overlay') as Overlay['id'][]);
  };
  for (const base of preset?.baseMaps ?? [])
    panel.append(choice('radio', 'base', base.id, base.name, base.id === hooks.base));
  panel.append(document.createElement('hr'));
  for (const overlay of preset?.overlays ?? [])
    panel.append(choice('checkbox', 'overlay', overlay.id, overlay.name, hooks.overlays.includes(overlay.id)));
  panel.addEventListener('change', changed);
  return panel;
}

function choice(
  type: 'radio' | 'checkbox',
  name: string,
  value: string,
  text: string,
  checked: boolean,
): HTMLLabelElement {
  const label = document.createElement('label');
  label.style.display = 'block';
  const input = document.createElement('input');
  input.type = type;
  input.name = name;
  input.value = value;
  input.checked = checked;
  label.append(input, ` ${text}`);
  return label;
}
