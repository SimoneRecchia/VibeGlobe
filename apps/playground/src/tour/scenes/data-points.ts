// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** The Data chapter's point scenes: 100,000 markers with level of detail or clusters, and live moving points. */
import type { CameraMovement } from '@vibeglobe/core';
import { ClusterLayer, DataLayer, fitObjects, MarkerLodLayer, type Feature } from '@vibeglobe/layers';
import { markerImages } from '../../marker-images.js';
import type { SceneContext, SceneModule } from '../types.js';

/** Places the scattered points gather around. */
const HUBS: readonly (readonly [lon: number, lat: number, spreadDeg: number])[] = [
  [9.19, 45.46, 1.6],
  [12.5, 41.9, 1.4],
  [2.35, 48.86, 1.8],
  [13.4, 52.52, 1.5],
  [-3.7, 40.42, 1.6],
  [4.9, 52.37, 1.0],
  [16.37, 48.21, 1.1],
  [-0.13, 51.51, 1.6],
  [14.27, 40.85, 0.8],
  [8.54, 47.37, 0.9],
];

/** `count` points scattered around the hubs, the same at every visit. */
function scatter(count: number): Feature[] {
  let seed = 7;
  const random = (): number => ((seed = (seed * 16_807) % 2_147_483_647) - 1) / 2_147_483_646;
  return Array.from({ length: count }, (_, i) => {
    const [lon, lat, spread] = HUBS[i % HUBS.length] ?? [0, 0, 1];
    const r = spread * Math.sqrt(-2 * Math.log(random() + 1e-9)) * 0.5;
    const a = random() * 2 * Math.PI;
    return {
      type: 'Feature' as const,
      id: i,
      properties: { hub: i % HUBS.length },
      geometry: { type: 'Point' as const, coordinates: [lon + r * Math.cos(a) * 1.4, lat + r * Math.sin(a)] },
    };
  });
}

type Look = 'lod' | 'clusters' | 'points';

/** The layer of one look at the points. */
function layerOf(look: Look, data: Feature[]): DataLayer {
  if (look === 'lod')
    return new MarkerLodLayer({
      id: 'markers-lod',
      data,
      style: { 'icon-image': 'pin', 'icon-anchor': 'bottom', 'icon-size': 24 },
      lod: { dotStyle: { 'circle-color': '#e8453c', 'circle-radius': 2 } },
    });
  if (look === 'clusters')
    return new ClusterLayer({
      id: 'markers-clusters',
      data,
      cluster: { radiusPx: 60 },
      style: {
        'circle-color': ['case', ['has', 'point_count'], '#ff8a00', '#3d5afe'],
        'circle-radius': [
          'case',
          ['has', 'point_count'],
          ['interpolate', ['linear'], ['get', 'point_count'], 2, 10, 5000, 28],
          4,
        ],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5,
      },
    });
  return new DataLayer('point', {
    id: 'markers-points',
    data,
    capacity: data.length,
    style: { 'circle-color': '#3d5afe', 'circle-radius': 2.5 },
  });
}

/** 100,000 markers: level of detail, clusters or plain points. */
export const markers: SceneModule = {
  code: `import { MarkerLodLayer } from '@vibeglobe/layers';

globe.layerTarget()?.addImage('pin', pinCanvas);
const markers = stack.add(
  new MarkerLodLayer({
    data: features, // 100,000 points
    style: { 'icon-image': 'pin', 'icon-anchor': 'bottom', 'icon-size': 24 },
    lod: { dotStyle: { 'circle-color': '#e8453c', 'circle-radius': 2 } },
  }),
);
console.log(markers.lodStats); // { full, simplified, fading }`,
  start(context) {
    const { globe, panel, layers } = context;
    for (const [name, image] of Object.entries(markerImages())) globe.layerTarget()?.addImage?.(name, image);
    context.go({ longitudeDeg: 7.5, latitudeDeg: 47, zoom: 4.6, tiltDeg: 0, headingDeg: 0 });
    const data = scatter(100_000);
    let layer: DataLayer | undefined;
    const readout = panel.readout();
    const show = (look: Look): void => {
      if (layer) layers.stack.remove(layer);
      layer = context.add(layerOf(look, data));
      readout([['Markers', data.length.toLocaleString('en')]]);
      if (layer instanceof ClusterLayer) {
        const clusters = layer;
        clusters.on('click', ({ feature }) => {
          const id = feature.properties['cluster_id'];
          if (typeof id === 'number')
            void clusters
              .clusterExtent(id)
              .then(({ bounds }) => bounds && globe.fitBounds(bounds, { paddingPx: 60, movement: 'ease' }));
        });
      }
    };
    panel.choice(
      'Draw them as',
      [
        ['lod', 'Level of detail'],
        ['clusters', 'Clusters'],
        ['points', 'Points'],
      ],
      'lod',
      show,
    );
    show('lod');
    context.on('frame', () => {
      if (!(layer instanceof MarkerLodLayer)) return;
      const { full, simplified, fading } = layer.lodStats;
      readout([
        ['Markers', data.length.toLocaleString('en')],
        ['Full markers', full.toLocaleString('en')],
        ['Dots', simplified.toLocaleString('en')],
        ['Fading', fading.toLocaleString('en')],
      ]);
    });
    panel.note('Zoom in: crowded and distant markers are dots that grow into pins. Clusters split as you zoom.');
  },
};

/** The live scene's city: vehicles on four ring roads and twelve radial roads around it. */
const CENTER = { lon: 9.19, lat: 45.465 };
const LON_SCALE = 1 / Math.cos(CENTER.lat * (Math.PI / 180));

/** Where vehicle `i` is at `t` seconds: odd ones round a ring, even ones back and forth along a spoke. */
function vehicleAt(i: number, t: number): [lon: number, lat: number] {
  const speed = 0.04 + (i % 7) * 0.012;
  if (i % 2) {
    const radius = 0.025 * (1 + (i % 4));
    const angle = ((i * 2.399) % (2 * Math.PI)) + t * speed * (i % 3 === 0 ? -1 : 1) * (0.1 / radius);
    return [CENTER.lon + radius * LON_SCALE * Math.cos(angle), CENTER.lat + radius * Math.sin(angle)];
  }
  const spoke = ((i / 2) % 12) * (Math.PI / 6);
  const along = 0.11 * Math.abs(Math.sin(i * 0.37 + t * speed));
  return [CENTER.lon + along * LON_SCALE * Math.cos(spoke), CENTER.lat + along * Math.sin(spoke)];
}

/** Moves every vehicle one step per display frame until paused or left. */
function animate(layer: DataLayer, count: number, context: SceneContext): (on: boolean) => void {
  let frame = 0;
  const step = (timeMs: number): void => {
    for (let i = 0; i < count; i++) {
      const [lon, lat] = vehicleAt(i, timeMs / 1000);
      layer.setFeaturePosition(i, lon, lat, 0);
    }
    frame = requestAnimationFrame(step);
  };
  const set = (on: boolean): void => {
    cancelAnimationFrame(frame);
    if (on) frame = requestAnimationFrame(step);
  };
  context.defer(() => set(false));
  return set;
}

const selected = ['boolean', ['feature-state', 'selected'], false];

/** The fleet's layer: buses, trams and taxis colored by kind, larger when hovered or selected. */
function fleetLayer(count: number): DataLayer {
  const kinds = ['bus', 'tram', 'taxi'] as const;
  return new DataLayer('point', {
    id: 'fleet',
    capacity: count,
    data: Array.from({ length: count }, (_, i) => ({
      type: 'Feature' as const,
      id: i,
      properties: { kind: kinds[i % 3] },
      geometry: { type: 'Point' as const, coordinates: vehicleAt(i, 0) },
    })),
    style: {
      'circle-color': ['match', ['get', 'kind'], 'bus', '#ff7a00', 'tram', '#00b894', '#3d5afe'],
      'circle-radius': ['case', ['boolean', ['feature-state', 'hover'], false], 9, selected, 8, 3.5],
      'circle-stroke-color': ['case', selected, '#ffd400', '#ffffff'],
      'circle-stroke-width': ['case', selected, 3, 0.8],
    },
  });
}

/** Selection by click and the two framing buttons. */
function interact(context: SceneContext, fleet: DataLayer, count: number): void {
  const { globe, panel, layers } = context;
  const readout = panel.readout();
  let chosen: number | undefined;
  fleet.on('click', ({ feature }) => {
    layers.interaction.clearSelection();
    layers.interaction.select(feature.layerId, feature.id);
    chosen = Number(feature.id);
    readout([['Selected', `${String(feature.properties['kind'])} ${String(feature.id)}`]]);
  });
  let flight: CameraMovement | undefined;
  context.defer(() => {
    flight?.cancel();
    layers.interaction.clearSelection();
  });
  const frameSelected = (): void => {
    const at = chosen === undefined ? undefined : fleet.getPosition(chosen);
    if (at) flight = fitObjects(globe, [at], { paddingPx: 120, movement: 'ease' });
  };
  const frameAll = (): void => {
    const sample = Array.from({ length: 250 }, (_, i) => fleet.getPosition((i * count) / 250)).filter(
      (p) => p !== undefined,
    );
    flight = fitObjects(globe, sample, { paddingPx: 40 });
  };
  panel.buttons(['Frame the selected', frameSelected], ['Frame them all', frameAll]);
}

/** Five thousand moving points, hovered, selected and framed. */
export const live: SceneModule = {
  code: `const fleet = stack.add(new DataLayer('point', { data: vehicles, style: {
  'circle-color': ['match', ['get', 'kind'], 'bus', '#ff7a00', 'tram', '#00b894', '#3d5afe'],
  'circle-radius': ['case', ['boolean', ['feature-state', 'hover'], false], 9, 5],
} }));
fleet.setFeaturePosition('bus-7', 9.19, 45.46); // in place, no rebuild
fleet.on('click', ({ feature }) => interaction.select(feature.layerId, feature.id));
await fitObjects(globe, [fleet.getPosition('bus-7')], { paddingPx: 40 });`,
  start(context) {
    const count = 5000;
    context.go({ longitudeDeg: CENTER.lon, latitudeDeg: CENTER.lat, zoom: 11.2, tiltDeg: 0, headingDeg: 0 });
    const fleet = context.add(fleetLayer(count));
    const play = animate(fleet, count, context);
    play(true);
    context.panel.toggle('Moving', true, play);
    interact(context, fleet, count);
    context.panel.note(
      'Each frame moves 5,000 points in place: only their positions are uploaded. Hover and click them.',
    );
  },
};
