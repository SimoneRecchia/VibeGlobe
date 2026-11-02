// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The Europe preset's map types (online, after the visitor's consent): the base map's imagery layers added at runtime,
 * its vector overlays drawn from OpenFreeMap's style. Its 3D terrain is the Terrain chapter's Real terrain scene.
 */
import type { ImageryLayerOptions } from '@vibeglobe/core';
import type { VectorTileLayer } from '@vibeglobe/layers/vector-tiles';
import type { BaseMap, EuropePreset, Overlay, StyleJson } from '@vibeglobe/presets';
import type { SceneContext, SceneModule } from '../types.js';

const NATURAL_EARTH_CAPS = { north: '#78a9cd', south: '#f2f3f7' } as const;

/** Shows a base map and overlays: imagery layers by id, the composed style, the caps' colors. */
function mapTypes(context: SceneContext, preset: EuropePreset, style: StyleJson) {
  const { globe, container } = context;
  const added = new Set<string>();
  let vectors: VectorTileLayer | undefined;
  let pending = Promise.resolve();
  context.defer(() => {
    for (const id of added) globe.imageryLayers.remove(id);
    vectors?.remove();
    globe.setPolarCapColors(NATURAL_EARTH_CAPS);
  });
  const show = async (base: BaseMap['id'], overlays: readonly Overlay['id'][]): Promise<void> => {
    const map = preset.baseMaps.find((b) => b.id === base);
    const wanted: readonly ImageryLayerOptions[] = map?.imagery ?? [];
    for (const id of added)
      if (!wanted.some((layer) => layer.id === id)) {
        globe.imageryLayers.remove(id);
        added.delete(id);
      }
    for (const layer of wanted)
      if (layer.id !== undefined && !added.has(layer.id)) {
        globe.imageryLayers.add(layer);
        added.add(layer.id);
      }
    globe.setPolarCapColors(map?.polarCapColors ?? NATURAL_EARTH_CAPS);
    const [{ addVectorTiles }, { createVectorTileTarget }] = await Promise.all([
      import('@vibeglobe/layers/vector-tiles'),
      import('@vibeglobe/renderer/vector-tiles'),
    ]);
    vectors?.remove();
    vectors = undefined;
    const composed = preset.styleFor(style, base, overlays);
    if (!composed || context.signal.aborted) return;
    const layer = await addVectorTiles(globe, {
      style: composed,
      target: createVectorTileTarget,
      element: container,
      localFontFamily: 'sans-serif',
    });
    if (context.signal.aborted) layer.remove();
    else vectors = layer;
  };
  // One change at a time: a style still loading is replaced by the next.
  return (base: BaseMap['id'], overlays: readonly Overlay['id'][]): void => {
    pending = pending.then(() => show(base, overlays));
  };
}

/** The Europe preset's base maps and overlays. */
export const europe: SceneModule = {
  code: `import { europeOpen, type StyleJson } from '@vibeglobe/presets';

const preset = europeOpen();
const hybrid = preset.baseMaps.find((b) => b.id === 'hybrid');
for (const layer of hybrid?.imagery ?? []) globe.imageryLayers.add(layer);
const style = (await (await fetch(preset.styleUrl('online'))).json()) as StyleJson;
const composed = preset.styleFor(style, 'hybrid', ['buildings']);
if (composed) await addVectorTiles(globe, { style: composed, target: createVectorTileTarget });`,
  async start(context) {
    const { europeOpen } = await import('@vibeglobe/presets');
    const preset = europeOpen();
    const style = (await (await fetch(preset.styleUrl('online'), { signal: context.signal })).json()) as StyleJson;
    const show = mapTypes(context, preset, style);
    const state = { base: 'hybrid' as BaseMap['id'], overlays: new Set<Overlay['id']>(['borders']) };
    const apply = (): void => show(state.base, [...state.overlays]);
    apply();
    context.go({ longitudeDeg: 11.2, latitudeDeg: 45.9, zoom: 6.4, headingDeg: 0, tiltDeg: 0 });
    const { panel, globe } = context;
    panel.choice(
      'Map type',
      preset.baseMaps.map((b) => [b.id, b.name] as const),
      state.base,
      (base) => ((state.base = base), apply()),
    );
    const group = panel.group('Overlays');
    for (const overlay of preset.overlays.filter((o) => o.id !== 'terrain'))
      group.toggle(overlay.name, state.overlays.has(overlay.id), (on) => {
        if (on) state.overlays.add(overlay.id);
        else state.overlays.delete(overlay.id);
        apply();
      });
    panel.buttons(
      ['Venice', () => void globe.flyTo({ longitudeDeg: 12.3358, latitudeDeg: 45.4371, zoom: 15.5, tiltDeg: 0 })],
      ['Paris', () => void globe.flyTo({ longitudeDeg: 2.2945, latitudeDeg: 48.8584, zoom: 16, tiltDeg: 55 })],
      ['The Alps', () => void globe.flyTo({ longitudeDeg: 9.5, latitudeDeg: 46.4, zoom: 7.2, tiltDeg: 0 })],
    );
    panel.note(`Sources: ${preset.sources.map((source) => source.name).join(' · ')}.`);
    panel.note('3D terrain is chosen when the globe is created: the Terrain chapter’s Real terrain scene shows it.');
  },
};
