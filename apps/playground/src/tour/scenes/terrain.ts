// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The Terrain chapter: the fixture server's analytic terrain (a 4,000 m peak at 6.86° E, 45.83° N and a ridge along
 * 46.5° N) offline, and Mapterhorn's terrain of Europe under the preset's satellite imagery online. Both read the
 * height under the pointer and pin the ground a click picks.
 */
import { watchClicks } from '@vibeglobe/controls';
import type { GeoPosition, ViewInit } from '@vibeglobe/core';
import { DataLayer, LabelLayer } from '@vibeglobe/layers';
import type { SceneContext, SceneModule } from '../types.js';
import { freeTilt } from './tilt.js';

const metres = (value: number): string => `${Math.round(value).toLocaleString('en')} m`;
const degrees = (p: GeoPosition): string => `${p.latitudeDeg.toFixed(4)}°, ${p.longitudeDeg.toFixed(4)}°`;

/** Morning sunlight from the south-east, which shades the relief, and a clear air; restored when the scene is left. */
function sunlight(context: SceneContext): void {
  const before = context.globe.atmosphere;
  context.defer(() =>
    context.globe.setAtmosphere({ sunLighting: before.sunLighting, timeMs: before.timeMs, haze: before.haze }),
  );
  context.globe.setAtmosphere({ sunLighting: true, timeMs: Date.UTC(2026, 5, 21, 7, 30), haze: 0.25 });
}

/** The pins of picked ground: a point and its height as a label, both on the terrain. */
function pins(context: SceneContext): (position: GeoPosition, heightMeters: number) => void {
  const points = context.add(
    new DataLayer('point', {
      id: 'terrain-picks',
      style: {
        'circle-color': '#ff5a36',
        'circle-radius': 6,
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 2,
      },
    }),
  );
  const labels = context.add(
    new LabelLayer({
      id: 'terrain-pick-labels',
      style: {
        'text-field': ['get', 'height'],
        'text-size': 14,
        'text-color': '#ffffff',
        'text-halo-color': '#202124',
        'text-halo-width': 2,
        'text-offset': [0, -1.4],
      },
    }),
  );
  let next = 0;
  return (position, heightMeters) => {
    const id = `pick-${String(++next)}`;
    const geometry = { type: 'Point' as const, coordinates: [position.longitudeDeg, position.latitudeDeg] };
    points.addFeatures([{ type: 'Feature', id, properties: {}, geometry }]);
    labels.addFeatures([{ type: 'Feature', id, properties: { height: metres(heightMeters) }, geometry }]);
  };
}

/** The readouts of the height under the pointer and of the eye, and the pins of clicks. */
function probe(context: SceneContext): void {
  const { globe, container, panel } = context;
  const pointer = panel.readout();
  const pin = pins(context);
  const move = (event: PointerEvent): void => {
    const box = container.getBoundingClientRect();
    const position = globe.screenToGeo({ xPx: event.clientX - box.left, yPx: event.clientY - box.top });
    if (!position) return pointer([['Under the pointer', 'the sky']]);
    const sample = globe.elevationAt(position);
    pointer([
      ['Under the pointer', degrees(position)],
      ['Ground', sample.noData ? 'no terrain' : `${metres(sample.heightMeters)} · level ${String(sample.level)}`],
    ]);
  };
  container.addEventListener('pointermove', move);
  context.defer(() => container.removeEventListener('pointermove', move));
  const eye = panel.readout();
  const update = (): void => {
    const camera = globe.camera;
    eye([
      ['Ground under the eye', metres(camera.groundHeightMeters)],
      ['Eye above the ellipsoid', metres(camera.altitudeMeters)],
    ]);
  };
  context.on('camera-change', update);
  update();
  const picked = panel.readout();
  context.defer(
    watchClicks(container, globe, ({ position }) => {
      if (!position) return;
      void globe.elevationAtAsync(position, { signal: context.signal }).then((finest) => {
        pin(position, finest.heightMeters);
        picked([
          ['Picked', degrees(position)],
          ['Finest height', metres(finest.heightMeters)],
        ]);
      });
    }),
  );
  panel.note('Click the ground to pin its height, loaded from the finest terrain tile.');
}

/**
 * A MapLibre style of the terrain's own tiles: a tint by elevation and a hillshade, draped over the relief, so the
 * shapes read where the base image is a blur.
 */
async function reliefStyle(context: SceneContext): Promise<void> {
  const [{ addVectorTiles }, { createVectorTileTarget }] = await Promise.all([
    import('@vibeglobe/layers/vector-tiles'),
    import('@vibeglobe/renderer/vector-tiles'),
  ]);
  const tiles = `${location.origin}${import.meta.env.BASE_URL}fixture-tiles/showcase/terrain/mercator/{z}/{x}/{y}.terrarium.png`;
  const layer = await addVectorTiles(context.globe, {
    target: createVectorTileTarget,
    style: {
      version: 8,
      sources: { dem: { type: 'raster-dem', tiles: [tiles], tileSize: 256, encoding: 'terrarium', maxzoom: 13 } },
      layers: [
        {
          id: 'tint',
          type: 'color-relief',
          source: 'dem',
          minzoom: 7,
          paint: {
            'color-relief-color': [
              'interpolate',
              ['linear'],
              ['elevation'],
              -300,
              '#4f8a4b',
              400,
              '#8fae5d',
              1400,
              '#cdbb7e',
              2400,
              '#a08770',
              3200,
              '#cfcac4',
              3800,
              '#ffffff',
            ],
            'color-relief-opacity': 0.9,
          },
        },
        {
          id: 'shade',
          type: 'hillshade',
          source: 'dem',
          minzoom: 7,
          paint: { 'hillshade-exaggeration': 0.55, 'hillshade-shadow-color': '#2c2414' },
        },
      ],
    },
  });
  if (context.signal.aborted) layer.remove();
  else context.defer(() => layer.remove());
}

/** The analytic peak of the fixture terrain, shaded by a low Sun. */
export const relief: SceneModule = {
  code: `import { createGlobe } from '@vibeglobe/core';
import { heightmapTerrain } from '@vibeglobe/sources';
import { createWorkers } from '@vibeglobe/worker';

const terrain = heightmapTerrain({ id: 'dem', url: '/dem/{z}/{x}/{y}.png', encoding: 'terrarium' });
const globe = createGlobe({ /* … */ terrain, workers: createWorkers() });
globe.elevationAt({ longitudeDeg: 6.86, latitudeDeg: 45.83 }); // from the tiles in memory
await globe.elevationAtAsync({ longitudeDeg: 6.86, latitudeDeg: 45.83 }); // the finest tile
globe.screenToGeo({ xPx: 200, yPx: 150 }); // the terrain point drawn there`,
  async start(context) {
    const peak = { longitudeDeg: 6.86, latitudeDeg: 45.83 };
    sunlight(context);
    freeTilt(context);
    context.go({ longitudeDeg: 6.86, latitudeDeg: 45.8, zoom: 11.3, tiltDeg: 77, headingDeg: 10 });
    probe(context);
    await reliefStyle(context);
    context.panel.buttons(
      [
        'Circle the peak',
        () => void context.globe.orbit({ center: peak, degreesPerSecond: 12, signal: context.signal }),
      ],
      [
        'Along the ridge',
        () => void context.globe.flyTo({ longitudeDeg: 8.5, latitudeDeg: 46.42, zoom: 13, tiltDeg: 72, headingDeg: 0 }),
      ],
    );
    context.panel.note(
      'This terrain is generated by the playground’s fixture server: a peak, a ridge and gentle hills.',
    );
  },
};

const PLACES: Readonly<Record<string, ViewInit>> = {
  'Mont Blanc': { longitudeDeg: 6.8652, latitudeDeg: 45.8326, zoom: 12.1, tiltDeg: 68, headingDeg: 160 },
  Matterhorn: { longitudeDeg: 7.6586, latitudeDeg: 45.9763, zoom: 12.4, tiltDeg: 68, headingDeg: 235 },
  'Tre Cime': { longitudeDeg: 12.3047, latitudeDeg: 46.6187, zoom: 12.8, tiltDeg: 66, headingDeg: 20 },
};

/** Mapterhorn's terrain under the preset's satellite imagery. */
export const realTerrain: SceneModule = {
  code: `import { europeOpen } from '@vibeglobe/presets';

const preset = europeOpen();
const satellite = preset.baseMaps.find((b) => b.id === 'satellite');
const globe = createGlobe({
  /* … */
  imagery: satellite?.imagery ?? [],
  terrain: preset.terrain, // Mapterhorn's Terrarium tiles
  workers: createWorkers(),
});`,
  async start(context) {
    const { europeOpen } = await import('@vibeglobe/presets');
    for (const layer of europeOpen().baseMaps.find((b) => b.id === 'satellite')?.imagery ?? []) context.imagery(layer);
    freeTilt(context);
    context.go(PLACES['Mont Blanc'] ?? {});
    probe(context);
    context.panel.buttons(
      ...Object.entries(PLACES).map(([name, view]) => [name, () => void context.globe.flyTo(view)] as const),
    );
  },
};
