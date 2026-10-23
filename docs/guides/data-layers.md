---
title: Data layers
---

# Data layers

`@vibeglobe/layers` draws application data on the globe: points, markers, labels, lines, polygons, geodesic circles,
extrusions and glTF models, styled with MapLibre Style Specification properties and expressions, picked and dragged
with the pointer, and updated feature by feature without rebuilding a layer (ADR 0029, ADR 0037). Every example below
runs as written in `e2e/data-layers-guide.spec.ts`, with `globe` a globe that has finished `globe.ready`.

## Primitives

A layer holds one primitive kind. `createGlobeLayers` connects a layer stack to a globe: its batches go to the globe's
renderer, and every drawn frame advances it with the frame's clock and zoom. Data is GeoJSON: a `FeatureCollection` or
an array of features.

```ts
import { createGlobeLayers, DataLayer } from '@vibeglobe/layers';

const { stack } = createGlobeLayers(globe);
stack.add(
  new DataLayer('point', {
    id: 'cities',
    data: [
      { type: 'Feature', id: 'rome', properties: {}, geometry: { type: 'Point', coordinates: [12.5, 41.9] } },
      { type: 'Feature', id: 'milan', properties: {}, geometry: { type: 'Point', coordinates: [9.19, 45.46] } },
    ],
    style: { 'circle-color': '#e03020', 'circle-radius': 6 },
  }),
);
stack.add(
  new DataLayer('polyline', {
    id: 'route',
    data: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [
            [12.5, 41.9],
            [9.19, 45.46],
          ],
        },
      },
    ],
    style: { 'line-color': '#2050ff', 'line-width': 4 },
  }),
);
stack.add(
  new DataLayer('circle', {
    id: 'range',
    data: [
      { type: 'Feature', properties: { radiusMeters: 50_000 }, geometry: { type: 'Point', coordinates: [12.5, 41.9] } },
    ],
    style: { 'fill-color': '#20c040', 'fill-opacity': 0.4 },
  }),
);
```

Kinds: `point` (`circle-*` properties), `marker` (`icon-*`, with images registered by name through
`globe.layerTarget()?.addImage(name, canvasOrImage)`), `label` (`text-*`), `polyline` (`line-*`), `polygon` (`fill-*`,
and `fill-extrusion-height` and `-base` for volumes) and `circle` (a center, `radiusMeters` and optionally
`minorRadiusMeters` and `rotationDeg`, drawn as the geodesic shape on the ellipsoid). glTF models are features of a
`ModelLayer` from `@vibeglobe/layers/models` (they need the renderer's glTF loader, `@vibeglobe/renderer/gltf`).

## Placement

Points, markers and labels stand on the terrain by default (`'clamp-to-ground'`), lines and polygons drape over it
(`'drape'`). An absolute altitude above the WGS84 ellipsoid puts every vertex without its own height there; a third
coordinate gives a vertex its own.

```ts
import { createGlobeLayers, DataLayer } from '@vibeglobe/layers';

const { stack } = createGlobeLayers(globe);
stack.add(
  new DataLayer('point', {
    id: 'aircraft',
    data: [{ type: 'Feature', id: 'az610', properties: {}, geometry: { type: 'Point', coordinates: [12.3, 41.8] } }],
    placement: { absoluteAltitudeMeters: 3000 },
    style: { 'circle-color': '#ffd000', 'circle-radius': 5 },
  }),
);
```

## Styling

Every property takes a value or an expression: data-driven from feature properties (`['get', name]`, `match`,
`case`, arithmetic), zoom-dependent (`interpolate` and `step` over `['zoom']`), or by feature state (`['feature-state',
'hover']`, `'selected'`). A malformed expression throws a `StyleError` listing every problem.

```ts
import { createGlobeLayers, DataLayer, StyleError } from '@vibeglobe/layers';

const { stack } = createGlobeLayers(globe);
stack.add(
  new DataLayer('point', {
    id: 'stations',
    data: [
      { type: 'Feature', properties: { kind: 'hot', load: 30 }, geometry: { type: 'Point', coordinates: [11, 44] } },
      { type: 'Feature', properties: { kind: 'cold', load: 10 }, geometry: { type: 'Point', coordinates: [11.5, 44] } },
    ],
    style: {
      'circle-color': ['match', ['get', 'kind'], 'hot', '#ff2020', 'cold', '#2040ff', '#808080'],
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, ['/', ['get', 'load'], 10], 10, ['get', 'load']],
      'circle-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 1, 0.8],
    },
  }),
);
try {
  new DataLayer('point', { style: { 'circle-radius': ['zoom'] } });
} catch (error) {
  if (!(error instanceof StyleError)) throw error;
}
```

## Clustering

A `ClusterLayer` groups nearby points per zoom and animates groups splitting and merging; `clusterExtent` gives the
bounds a cluster spans, so a click can zoom into it with `globe.fitBounds`.

```ts
import { ClusterLayer, createGlobeLayers } from '@vibeglobe/layers';

const { stack } = createGlobeLayers(globe);
stack.add(
  new ClusterLayer({
    id: 'sensors',
    data: Array.from({ length: 500 }, (_, i) => ({
      type: 'Feature' as const,
      id: i,
      properties: {},
      geometry: { type: 'Point' as const, coordinates: [10 + (i % 25) * 0.1, 43 + Math.floor(i / 25) * 0.1] },
    })),
    cluster: { radiusPx: 40 },
    style: { 'circle-color': '#ff8000', 'circle-radius': 8 },
  }),
);
```

## Labels

Labels take `text-field`, `text-font` (a font stack, before the system's fonts, which cover the scripts a font lacks),
`text-size`, `text-color`, `text-halo-color` and `-width`, `text-anchor` and `text-offset` (in ems). A `LabelLayer`
also avoids collisions, keeping the labels with the lower `symbol-sort-key` first, and fades labels in and out.

```ts
import { createGlobeLayers, LabelLayer } from '@vibeglobe/layers';

const { stack } = createGlobeLayers(globe);
stack.add(
  new LabelLayer({
    id: 'places',
    data: [
      {
        type: 'Feature',
        properties: { name: 'Roma', rank: 1 },
        geometry: { type: 'Point', coordinates: [12.5, 41.9] },
      },
      { type: 'Feature', properties: { name: 'Αθήνα', rank: 2 }, geometry: { type: 'Point', coordinates: [23.7, 38] } },
    ],
    style: {
      'text-field': ['get', 'name'],
      'text-font': ['literal', ['Noto Sans', 'sans-serif']],
      'text-size': 18,
      'text-color': '#ffffff',
      'text-halo-color': '#202020',
      'text-halo-width': 2,
      'text-anchor': 'top',
      'text-offset': ['literal', [0, 0.5]],
      'symbol-sort-key': ['get', 'rank'],
    },
  }),
);
```

## Picking, events and selection

With `element` (the globe's container or canvas), `createGlobeLayers` routes pointer events to feature interaction:
layers emit `hover-enter`, `hover-leave`, `click`, and for draggable layers `drag-start`, `drag` and `drag-end`, each
with the feature, its layer and the position under the pointer (on the terrain drawn there, with its elevation).
`interaction.select` sets a feature's `selected` state, which styles can read.

```ts
import { createGlobeLayers, DataLayer } from '@vibeglobe/layers';

const element = document.querySelector<HTMLElement>('#globe') ?? undefined;
const { stack, interaction } = createGlobeLayers(globe, element ? { element } : {});
const sites = stack.add(
  new DataLayer('point', {
    id: 'sites',
    data: [{ type: 'Feature', id: 'a', properties: {}, geometry: { type: 'Point', coordinates: [12.5, 41.9] } }],
    style: { 'circle-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#ffff00', '#e03020'] },
  }),
);
sites.on('click', ({ feature, position }) => {
  interaction.select(feature.layerId, feature.id);
  console.log(`${String(feature.id)} at ${position?.longitudeDeg}, ${position?.latitudeDeg}`);
});
interaction.select('sites', 'a');
```

## Live updates and fitting the view

One feature's position, properties, state or visibility changes in place: only its vertices are uploaded, and the
change shows in the next frame. `fitObjects` frames features and positions, heights included, with padding.

```ts
import { createGlobeLayers, DataLayer, fitObjects } from '@vibeglobe/layers';

const { stack } = createGlobeLayers(globe);
const fleet = stack.add(
  new DataLayer('point', {
    id: 'fleet',
    data: [
      {
        type: 'Feature',
        id: 'bus-7',
        properties: { late: false },
        geometry: { type: 'Point', coordinates: [12.48, 41.89] },
      },
    ],
    style: { 'circle-color': ['case', ['get', 'late'], '#ff2020', '#20a040'], 'circle-radius': 6 },
  }),
);
fleet.setFeaturePosition('bus-7', 12.49, 41.9);
fleet.updateFeature('bus-7', { properties: { late: true } });
fleet.setFeatureVisible('bus-7', true);
await fitObjects(
  globe,
  [
    { longitudeDeg: 12.49, latitudeDeg: 41.9 },
    { longitudeDeg: 12.52, latitudeDeg: 41.92, heightMeters: 300 },
  ],
  { paddingPx: 40, movement: 'ease' },
);
```

## Custom layers

Any object implementing `Layer` (attach, detach, setOrder, setVisible, frame) can join a stack: it draws through the
`LayerRenderTarget` it receives, reserves pick ids with `acquirePickSlot`, and asks for frames with `requestFrame`.
The built-in layers are written against the same interface.
