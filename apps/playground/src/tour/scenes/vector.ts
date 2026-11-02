// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The Vector chapter: the playground's bundled styles over its fixture tiles (`public/vector-tiles/`: invented streets
 * of Milan, MapLibre's demotiles of the world, a DEM of the Mont Blanc massif), 3D buildings, and OpenFreeMap online.
 */
import type { ViewInit } from '@vibeglobe/core';
import type { PickedVectorFeature, VectorTileLayer } from '@vibeglobe/layers/vector-tiles';
import type { Readout } from '../panel.js';
import type { SceneContext, SceneModule } from '../types.js';

const STYLES = `${import.meta.env.BASE_URL}vector-tiles/styles/`;
const DEMOTILES = 'https://demotiles.maplibre.org/';
const MILAN = { longitudeDeg: 9.19, latitudeDeg: 45.465 };

/** MapLibre's demotiles host, answered by the bundled copy of its tiles and glyphs. */
function localDemotiles(url: string): string {
  if (!url.startsWith(DEMOTILES)) return url;
  const rest = url.slice(DEMOTILES.length);
  const local = `${location.origin}${import.meta.env.BASE_URL}vector-tiles/`;
  if (rest.startsWith('tiles/')) return `${local}demotiles/${rest.slice('tiles/'.length)}`;
  if (rest.startsWith('font/')) return `${local}glyphs/Inter%20Bold/${rest.split('/').pop() ?? ''}`;
  return url;
}

/** A feature's main facts for the readout. */
function describe(feature: PickedVectorFeature): (readonly [string, string])[] {
  const name = feature.properties['name'] ?? feature.properties['name:en'] ?? feature.properties['class'];
  return [
    ['Layer', feature.layerId],
    ['Source layer', feature.sourceLayer ?? '—'],
    ...(name === undefined ? [] : ([['Name', String(name)]] as const)),
    ...(feature.building ? ([['Building height', `${feature.building.heightMeters.toFixed(1)} m`]] as const) : []),
  ];
}

/** Draws a style until the scene is left; clicks show the picked feature in `readout`. */
async function drawStyle(context: SceneContext, style: string, readout?: Readout): Promise<VectorTileLayer> {
  const [{ addVectorTiles }, { createVectorTileTarget }] = await Promise.all([
    import('@vibeglobe/layers/vector-tiles'),
    import('@vibeglobe/renderer/vector-tiles'),
  ]);
  const layer = await addVectorTiles(context.globe, {
    style,
    target: createVectorTileTarget,
    element: context.container,
    localFontFamily: 'sans-serif',
    transformUrl: localDemotiles,
  });
  if (context.signal.aborted) {
    layer.remove();
    throw new Error('left');
  }
  context.defer(() => layer.remove());
  if (readout)
    context.defer(
      layer.on(({ type, feature }) => {
        if (type === 'click') readout(describe(feature));
      }),
    );
  return layer;
}

const GALLERY: Readonly<Record<string, { title: string; view: ViewInit; mode?: '2d' }>> = {
  streets: { title: 'Streets', view: { ...MILAN, zoom: 14.2, tiltDeg: 0 }, mode: '2d' },
  'type-symbol': { title: 'Labels', view: { ...MILAN, zoom: 15, tiltDeg: 0 }, mode: '2d' },
  'type-line': { title: 'Lines', view: { ...MILAN, zoom: 14, tiltDeg: 0 }, mode: '2d' },
  'type-heatmap': { title: 'Heatmap', view: { ...MILAN, zoom: 12.5, tiltDeg: 0 }, mode: '2d' },
  'type-hillshade': {
    title: 'Hillshade',
    view: { longitudeDeg: 6.86, latitudeDeg: 45.72, zoom: 10.6, tiltDeg: 0 },
    mode: '2d',
  },
  demotiles: { title: 'World', view: { longitudeDeg: 15, latitudeDeg: 30, zoom: 1.6, tiltDeg: 0 } },
};

/** A gallery of the bundled styles, the language of names, a paint change and picking. */
export const styles: SceneModule = {
  code: `import { addVectorTiles } from '@vibeglobe/layers/vector-tiles';
import { createVectorTileTarget } from '@vibeglobe/renderer/vector-tiles';

const layer = await addVectorTiles(globe, {
  style: 'https://tiles.example.com/styles/streets.json',
  target: createVectorTileTarget,
  element: container, // hover and click
});
layer.style.setPaintProperty('water', 'fill-color', '#2060c0');
layer.setLanguage('it');
layer.on(({ type, feature }) => type === 'click' && console.log(feature.properties));`,
  async start(context) {
    const { globe, panel } = context;
    const mode = globe.viewMode;
    context.defer(() => globe.setViewMode(mode === 'manual' ? '3d' : mode));
    const picked = panel.readout();
    let current: VectorTileLayer | undefined;
    let ticket = 0;
    const show = async (name: string): Promise<void> => {
      const entry = GALLERY[name];
      if (!entry) return;
      const mine = ++ticket;
      current?.remove();
      current = undefined;
      globe.setViewMode(entry.mode ?? 'auto');
      context.go(entry.view);
      const layer = await drawStyle(context, `${STYLES}${name}.json`, picked).catch(() => undefined);
      if (mine === ticket) current = layer;
      else layer?.remove();
    };
    context.defer(() => current?.remove());
    panel.choice(
      'Style',
      Object.entries(GALLERY).map(([id, { title }]) => [id, title] as const),
      'streets',
      (name) => void show(name),
    );
    panel.choice(
      'Names',
      [
        ['en', 'English'],
        ['it', 'Italiano'],
      ],
      'en',
      (language) => current?.setLanguage(language),
    );
    panel.color('Water', '#8cc3e0', (color) => current?.style.setPaintProperty('water', 'fill-color', color));
    panel.note('Click a feature to read it. The tiles are invented data shaped like OpenMapTiles.');
    await show('streets');
  },
};

/** The streets style's buildings, extruded from their tags, seen tilted. */
export const buildings: SceneModule = {
  code: `// A style's fill-extrusion layer takes each building's height from its tags:
// height, else building:levels × 3 m, else a default per building type.
const [top] = layer.queryRenderedFeatures({ xPx: 200, yPx: 150 });
console.log(top?.building?.heightMeters);
layer.style.setPaintProperty('building', 'fill-extrusion-opacity', 0.6);`,
  async start(context) {
    const { panel } = context;
    context.go({ longitudeDeg: 9.1905, latitudeDeg: 45.4635, zoom: 15.7, tiltDeg: 60, headingDeg: 330 });
    const picked = panel.readout();
    const layer = await drawStyle(context, `${STYLES}streets.json`, picked);
    panel.slider('Opacity', { min: 0.2, max: 1, step: 0.05, value: 1 }, (value) =>
      layer.style.setPaintProperty('building', 'fill-extrusion-opacity', value),
    );
    panel.toggle('Buildings', true, (on) => layer.style.setVisibility('building', on));
    panel.note('Hover a building to highlight it; click it to read its height.');
  },
};

/** OpenFreeMap's Liberty style, online after consent. */
export const openFreeMap: SceneModule = {
  code: `const layer = await addVectorTiles(globe, {
  style: 'https://tiles.openfreemap.org/styles/liberty',
  target: createVectorTileTarget,
  element: container,
});
layer.setLanguage('fr');`,
  async start(context) {
    const { globe, panel } = context;
    context.go({ longitudeDeg: 2.2945, latitudeDeg: 48.8584, zoom: 15.6, tiltDeg: 55, headingDeg: 300 });
    const picked = panel.readout();
    const layer = await drawStyle(context, 'https://tiles.openfreemap.org/styles/liberty', picked);
    panel.choice(
      'Names',
      [
        ['en', 'English'],
        ['fr', 'Français'],
        ['it', 'Italiano'],
        ['ja', '日本語'],
      ],
      'en',
      (language) => layer.setLanguage(language),
    );
    panel.buttons(
      [
        'Paris',
        () =>
          void globe.flyTo({ longitudeDeg: 2.2945, latitudeDeg: 48.8584, zoom: 15.6, tiltDeg: 55, headingDeg: 300 }),
      ],
      [
        'New York',
        () =>
          void globe.flyTo({ longitudeDeg: -73.9857, latitudeDeg: 40.7484, zoom: 15.2, tiltDeg: 60, headingDeg: 30 }),
      ],
      ['Tokyo', () => void globe.flyTo({ longitudeDeg: 139.7671, latitudeDeg: 35.6812, zoom: 15, tiltDeg: 50 })],
    );
    layer.setLanguage('en');
  },
};
