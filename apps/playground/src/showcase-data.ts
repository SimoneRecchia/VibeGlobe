// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The showcase's demo data (owner, 2026-10-25): city markers with clustering, a polygon, a line and labels, and a
 * geocoder stub over the same cities, so the search box shows the place-search interface without a service.
 */
import type { Geocoder, GeocoderResult, Globe } from '@vibeglobe/core';
import type { Feature, Geometry, GlobeLayers } from '@vibeglobe/layers';

/** Demo places: the markers, their labels and the geocoder stub's index. */
const CITIES: readonly (readonly [name: string, longitudeDeg: number, latitudeDeg: number])[] = [
  ['Roma', 12.4964, 41.9028],
  ['Milano', 9.19, 45.4642],
  ['Napoli', 14.2681, 40.8518],
  ['Torino', 7.6869, 45.0703],
  ['Venezia', 12.3155, 45.4408],
  ['Firenze', 11.2558, 43.7696],
  ['Chamonix', 6.8694, 45.9237],
  ['Paris', 2.3522, 48.8566],
  ['London', -0.1276, 51.5072],
  ['Berlin', 13.405, 52.52],
  ['Madrid', -3.7038, 40.4168],
  ['New York', -74.006, 40.7128],
  ['Tokyo', 139.6917, 35.6895],
  ['Sydney', 151.2093, -33.8688],
  ['Rio de Janeiro', -43.1729, -22.9068],
  ['Cape Town', 18.4241, -33.9249],
];

/** A geocoder over the demo cities, case-insensitive on any part of the name: the interface without a service. */
export const demoGeocoder: Geocoder = {
  search(query) {
    const q = query.trim().toLowerCase();
    const found: GeocoderResult[] = CITIES.filter(([name]) => q.length > 0 && name.toLowerCase().includes(q)).map(
      ([label, longitudeDeg, latitudeDeg]) => ({ label, longitudeDeg, latitudeDeg, zoom: 11 }),
    );
    return Promise.resolve(found);
  },
};

/** Scatters `count` markers around each city (a deterministic spread), so clusters form and split as one zooms. */
function markers(
  count: number,
): { type: 'Feature'; id: string; properties: { city: string }; geometry: { type: 'Point'; coordinates: number[] } }[] {
  const out = [];
  let seed = 1;
  const random = (): number => ((seed = (seed * 16_807) % 2_147_483_647) - 1) / 2_147_483_646;
  for (const [city, lon, lat] of CITIES)
    for (let i = 0; i < count; i++)
      out.push({
        type: 'Feature' as const,
        id: `${city}-${i}`,
        properties: { city },
        geometry: { type: 'Point' as const, coordinates: [lon + (random() - 0.5) * 0.6, lat + (random() - 0.5) * 0.4] },
      });
  return out;
}

/** One feature of a demo layer. */
function feature(id: string, geometry: Geometry, properties: Record<string, unknown> = {}): Feature {
  return { type: 'Feature', id, properties, geometry };
}

/** The polygon, the line and the labels. */
async function shapes(layers: GlobeLayers): Promise<void> {
  const { DataLayer, LabelLayer } = await import('@vibeglobe/layers');
  const ring = [
    [6.7, 45.75],
    [7.05, 45.75],
    [7.05, 45.98],
    [6.7, 45.98],
    [6.7, 45.75],
  ];
  layers.stack.add(
    new DataLayer('polygon', {
      id: 'demo-area',
      data: [feature('alps', { type: 'Polygon', coordinates: [ring] }, { name: 'Mont Blanc massif' })],
      style: { 'fill-color': '#1e88e5', 'fill-opacity': 0.25 },
    }),
  );
  const route = [
    [9.19, 45.4642],
    [11.2558, 43.7696],
    [12.4964, 41.9028],
  ];
  layers.stack.add(
    new DataLayer('polyline', {
      id: 'demo-route',
      data: [feature('milano-roma', { type: 'LineString', coordinates: route })],
      style: { 'line-color': '#e53935', 'line-width': 3 },
    }),
  );
  layers.stack.add(
    new LabelLayer({
      id: 'demo-labels',
      data: CITIES.map(([name, lon, lat]) => feature(name, { type: 'Point', coordinates: [lon, lat] }, { name })),
      style: {
        'text-field': ['get', 'name'],
        'text-size': 14,
        'text-color': '#ffffff',
        'text-halo-color': '#202124',
        'text-halo-width': 2,
        'text-offset': [0, 1.2],
      },
    }),
  );
}

/**
 * Adds the demo layers to the page's layer stack: a click on a cluster zooms to its markers, one on a marker flies to
 * its city.
 */
export async function addDemoLayers(globe: Globe, layers: GlobeLayers): Promise<void> {
  const { ClusterLayer } = await import('@vibeglobe/layers');
  await shapes(layers);
  const clusters = layers.stack.add(
    new ClusterLayer({
      id: 'demo-markers',
      data: markers(40),
      style: {
        'circle-color': ['case', ['boolean', ['get', 'cluster'], false], '#fb8c00', '#3949ab'],
        'circle-radius': ['case', ['boolean', ['get', 'cluster'], false], 12, 5],
      },
    }),
  );
  clusters.on('click', ({ feature: picked }) => {
    const id = picked.properties['cluster_id'];
    if (typeof id === 'number') {
      void clusters.clusterExtent(id).then(({ bounds }) => {
        if (bounds) void globe.fitBounds(bounds, { movement: 'ease', durationMs: 600, paddingPx: 40 });
      });
      return;
    }
    const city = CITIES.find(([name]) => name === picked.properties['city']);
    if (city) void globe.flyTo({ longitudeDeg: city[1], latitudeDeg: city[2], zoom: 10 });
  });
}
