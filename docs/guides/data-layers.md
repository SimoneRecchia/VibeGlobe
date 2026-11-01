---
title: Data layers
---

# Data layers

`@vibeglobe/layers` draws application data on the globe from GeoJSON: points, markers, labels, lines, polygons,
extrusions and geodesic circles. Layers are styled with MapLibre Style Specification properties and expressions,
picked and dragged with the pointer, and changed one feature at a time without a rebuild. glTF models are in the
[models guide](models.md); MapLibre styles over vector tiles are in the [vector tiles guide](vector-tiles.md), and their
building heights at the end of this guide.

## Quick start

```ts
import { createGlobeLayers, DataLayer } from '@vibeglobe/layers';

declare const globe: import('@vibeglobe/core').Globe;

await globe.ready;
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
```

`createGlobeLayers` connects a `LayerStack` to the globe: the stack's batches go to the globe's renderer, and every
drawn frame advances it with the frame's clock and zoom. The two points draw from the next frame.

## Primitives

A `DataLayer` holds one kind of primitive. Its `data` is a `FeatureCollection`, an array of features, or an
`AsyncIterable` of feature arrays (a stream). Each kind reads only its own style properties:

- `point` (`Point`): `circle-color`, `circle-radius`, `circle-opacity`, `circle-stroke-color`, `circle-stroke-width`.
- `marker` (`Point`): `icon-image`, `icon-size`, `icon-rotate`, `icon-offset`, `icon-anchor`, `icon-opacity`,
  `icon-color`. `globe.layerTarget()?.addImage(name, image)` registers an image, bitmap or canvas that `icon-image`
  names.
- `label` (`Point`): `text-field`, `text-font`, `text-size`, `text-color`, `text-halo-color`, `text-halo-width`,
  `text-anchor`, `text-offset`, `text-rotate`, `text-opacity`, `symbol-sort-key`.
- `polyline` (`LineString`, `MultiLineString`): `line-color`, `line-width`, `line-opacity`.
- `polygon` (`Polygon`, `MultiPolygon`): `fill-color`, `fill-opacity`, `fill-outline-color`, and
  `fill-extrusion-height` and `fill-extrusion-base` in metres for volumes.
- `circle` (`Point`, the center): `fill-color`, `fill-opacity`, `fill-outline-color`. The feature properties
  `radiusMeters` (default 1,000), `minorRadiusMeters` (default: a circle) and `rotationDeg` (the major axis, clockwise
  from north, default 0) give a geodesic ellipse on the WGS84 ellipsoid, true to its ground size at any latitude.

```ts
import { createGlobeLayers, DataLayer } from '@vibeglobe/layers';

declare const globe: import('@vibeglobe/core').Globe;

const { stack } = createGlobeLayers(globe);
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
  new DataLayer('polygon', {
    id: 'depot',
    data: [
      {
        type: 'Feature',
        properties: { height: 40 },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [12.49, 41.89],
              [12.5, 41.89],
              [12.5, 41.9],
              [12.49, 41.89],
            ],
          ],
        },
      },
    ],
    style: { 'fill-color': '#a0a0a0', 'fill-extrusion-height': ['get', 'height'] },
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

Specialised layers build on `DataLayer`: `LabelLayer` (collision and fades), `ClusterLayer` (clusters per zoom),
`MarkerLodLayer` (distant or crowded markers drawn as dots, cross-fading to the full marker) and `GeoJsonLayer`
(GeoJSON, KML and GPX files). `pointLayer`, `markerLayer`, `labelLayer`, `polylineLayer`, `polygonLayer` and
`circleLayer` are factory shorthands; `pointLayer` with `cluster` returns a `ClusterLayer`.

## Placement

`placement` sets where features stand in height:

| `placement`                  | Heights                                                                          | Default for                     |
| ---------------------------- | -------------------------------------------------------------------------------- | ------------------------------- |
| `'clamp-to-ground'`          | On the terrain drawn, along every edge; a third coordinate is metres above it    | `point`, `marker`, `label`      |
| `'drape'`                    | The same as `'clamp-to-ground'`                                                  | `polyline`, `polygon`, `circle` |
| `{ absoluteAltitudeMeters }` | Metres above the WGS84 ellipsoid; a third coordinate overrides it for its vertex | none                            |

```ts
import { createGlobeLayers, DataLayer } from '@vibeglobe/layers';

declare const globe: import('@vibeglobe/core').Globe;

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

An HTML marker over the globe follows `globe.geoToScreen(position)` on every frame. The result is `undefined` behind
the camera; its `behindGlobe` is `true` when the globe hides the position (beyond the horizon, measured at the
position's own height), and always `false` on the flat map. Hide the marker in both cases.

## Styling

Every property takes a constant or an expression: data-driven (`['get', name]`, `match`, `case`, arithmetic,
`['geometry-type']`), zoom-dependent (`interpolate` and `step` over `['zoom']`), or by feature state
(`['feature-state', 'hover']`, `['feature-state', 'selected']`). A constant array, such as `'text-offset': [0, 0.5]`,
is a literal. A property the kind does not read, or a malformed expression, throws a `StyleError` whose `problems`
list every fault.

```ts
import { createGlobeLayers, DataLayer, StyleError } from '@vibeglobe/layers';

declare const globe: import('@vibeglobe/core').Globe;

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
  console.warn(error.problems);
}
```

## Clustering

A `ClusterLayer` groups nearby `Point` features per integer zoom and animates clusters splitting and merging. A
cluster's properties are `cluster`, `cluster_id`, `point_count` and `point_count_abbreviated`, as in MapLibre; a single
point keeps its own feature's id and properties. `clusterExtent(clusterId)` gives the bounds of a cluster's points.

```ts
import { ClusterLayer, createGlobeLayers } from '@vibeglobe/layers';

declare const globe: import('@vibeglobe/core').Globe;

const { stack } = createGlobeLayers(globe);
const sensors = stack.add(
  new ClusterLayer({
    id: 'sensors',
    data: Array.from({ length: 500 }, (_, i) => ({
      type: 'Feature' as const,
      id: i,
      properties: {},
      geometry: { type: 'Point' as const, coordinates: [10 + (i % 25) * 0.1, 43 + Math.floor(i / 25) * 0.1] },
    })),
    cluster: { radiusPx: 40 },
    style: { 'circle-color': '#ff8000', 'circle-radius': ['case', ['has', 'point_count'], 12, 6] },
  }),
);
sensors.on('click', async ({ feature }) => {
  const clusterId = feature.properties['cluster_id'];
  if (typeof clusterId !== 'number') return;
  const { bounds } = await sensors.clusterExtent(clusterId);
  if (bounds) await globe.fitBounds(bounds, { paddingPx: 40 });
});
```

`cluster` takes `radiusPx` (default 50, at 512-pixel tiles), `maxZoom` (the last zoom with clusters, default 16),
`minPoints` (default 2) and `transitionMs` (default 300). `kind: 'marker'` clusters markers instead of points.
`setData` replaces every point and rebuilds the index. The index is built on the main thread by default;
`engine: workerClusterEngine(workers)` of `@vibeglobe/layers/cluster-worker`, with the `createWorkers()` given to the
globe, builds and queries it in a worker.

## Labels

Labels take `text-field`, `text-font` (a font stack; the system's fonts follow it and cover the scripts it lacks),
`text-size`, `text-color`, `text-halo-color`, `text-halo-width`, `text-anchor` and `text-offset` (in ems). A
`LabelLayer` also avoids collisions, keeping the labels with the lower `symbol-sort-key` first, and fades labels in and
out.

```ts
import { createGlobeLayers, LabelLayer } from '@vibeglobe/layers';

declare const globe: import('@vibeglobe/core').Globe;

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
      'text-font': ['Noto Sans', 'sans-serif'],
      'text-size': 18,
      'text-color': '#ffffff',
      'text-halo-color': '#202020',
      'text-halo-width': 2,
      'text-anchor': 'top',
      'text-offset': [0, 0.5],
      'symbol-sort-key': ['get', 'rank'],
    },
  }),
);
```

`collision` tunes placement: `placementIntervalMs` (default 300), `fadeDurationMs` (default 300), `paddingPx` (default 2) and `budgetMs` (placement work per frame, default 4; a longer pass continues on the next frames). `isPlaced(id)`
says whether the last pass kept a label.

## Files: GeoJSON, KML and GPX

A `GeoJsonLayer` loads vector data and draws each geometry family with its own batch: polygons at the bottom, lines
above, points on top. `data` is a URL (`{ url }` or a `URL`), a `File` or `Blob`, text, bytes or a parsed
`FeatureCollection`; `format` is `geojsonFormat` (default), `kmlFormat` (KML and KMZ) or `gpxFormat`.

```ts
import { createGlobeLayers, GeoJsonLayer, kmlFormat } from '@vibeglobe/layers';

declare const globe: import('@vibeglobe/core').Globe;

const kml = `<kml xmlns="http://www.opengis.net/kml/2.2"><Placemark><name>Bridge</name>
<LineString><coordinates>12.46,41.9 12.48,41.91</coordinates></LineString></Placemark></kml>`;
const { stack } = createGlobeLayers(globe);
const routes = stack.add(
  new GeoJsonLayer({
    id: 'routes',
    data: kml,
    format: kmlFormat,
    style: { line: { 'line-color': '#ff00ff', 'line-width': 3 } },
  }),
);
routes.on('error', ({ message }) => console.warn(message));
await routes.loaded;
```

`style` has one `LayerStyle` per family: `point` (`circle-*`), `line` (`line-*`) and `polygon` (`fill-*`).
`part(family)` returns the `DataLayer` of one family, for updates. `workers` (the `createWorkers()` given to the globe)
parses in the engine's worker pool; without it parsing runs on the main thread.

## Picking, events and selection

With `element` (the globe's container), `createGlobeLayers` routes the element's pointer events to feature
interaction. Each layer emits its own events through `layer.on(type, handler)`, which returns the function that
unsubscribes.

| Event                            | When                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `hover-enter`, `hover-leave`     | The pointer enters or leaves a feature; the `hover` feature state follows it |
| `click`                          | A press and a release on the same feature                                    |
| `drag-start`, `drag`, `drag-end` | A `draggable` layer only; the feature moves with the pointer                 |
| `data`                           | Features were added (a streamed chunk, a loaded file): `{ added, total }`    |
| `error`                          | Data could not be loaded or parsed: `{ message, cause }`                     |

A pointer event's payload is a `FeatureEvent`: `feature` (`layerId`, `id`, `properties`), `position` (the point
under the pointer, on the terrain drawn there, with its height) and `screenPoint`. `interaction.select(layerId, id)`
sets a feature's `selected` state, which styles read; a click does not select by itself. `deselect`,
`clearSelection`, `selection` and `hovered` complete it.

```ts
import { createGlobeLayers, DataLayer } from '@vibeglobe/layers';

declare const globe: import('@vibeglobe/core').Globe;

const map = document.getElementById('map'); // the globe's container
const { stack, interaction } = createGlobeLayers(globe, map ? { element: map } : {});
const sites = stack.add(
  new DataLayer('point', {
    id: 'sites',
    data: [{ type: 'Feature', id: 'a', properties: {}, geometry: { type: 'Point', coordinates: [12.5, 41.9] } }],
    draggable: true,
    style: { 'circle-color': ['case', ['boolean', ['feature-state', 'selected'], false], '#ffff00', '#e03020'] },
  }),
);
sites.on('click', ({ feature, position }) => {
  interaction.select(feature.layerId, feature.id);
  console.log(`${String(feature.id)} at ${position?.longitudeDeg}, ${position?.latitudeDeg}`);
});
sites.on('drag-end', ({ feature }) => console.log(sites.getPosition(feature.id)));
interaction.select('sites', 'a');
```

A press within 16 CSS pixels of a draggable feature's anchor does not reach the map's controls, so the map does not
pan while the feature moves. A feature on the ground keeps its height above the terrain as it is dragged.

## Live updates and fitting the view

One feature changes in place: only its data is uploaded, and the change shows in the next frame. Every method returns
`false` for an unknown id.

| Method                                                  | Effect                                                          |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| `setFeaturePosition(id, lon, lat, heightMeters = 0)`    | Moves a feature without allocating (live feeds)                 |
| `setFeatureColor(id, r, g, b, a = 1)`                   | Recolors in 0–1 until a property, state or zoom re-evaluates it |
| `updateFeature(id, { position, geometry, properties })` | Properties merge, or replace with `replace: true`               |
| `setFeatureVisible(id, visible)`                        | Shows or hides one feature                                      |
| `setFeatureState(id, state)`                            | Merges state for `['feature-state', …]`; `undefined` clears it  |
| `addFeatures(features)`, `removeFeature(id)`            | Adds or removes features                                        |

`fitObjects(globe, objects, options)` flies to the view that frames features and positions, heights included: a
feature counts every vertex at its third coordinate or at its `fill-extrusion-height` or `height` property. Options
are `paddingPx` (a number, or `{ top, right, bottom, left }`), `movement` (`'fly'`, default, or `'ease'`) and
`tiltDeg`. It returns the globe's `CameraMovement`, a promise of the outcome with `cancel()`.

```ts
import { createGlobeLayers, DataLayer, fitObjects } from '@vibeglobe/layers';

declare const globe: import('@vibeglobe/core').Globe;

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

## The layer stack

`stack.add(layer, position)` adds a layer on top, or at `{ index }`, `{ above: id }` or `{ below: id }`, and returns
it. `move(id, position)`, `setVisible(id, visible)`, `get(id)`, `order`, `remove(layerOrId)` and `clear()` manage
the stack. `detach()` of the object `createGlobeLayers` returns stops following the globe's frames and the element's
pointer events.

## Custom layers

Any object implementing `Layer` (`id`, `attach`, `detach`, `setOrder`, `setVisible`, `frame`) can join a stack. It
draws through the `LayerRenderTarget` of the `LayerContext` it receives, reserves pick ids with `acquirePickSlot`, and
asks for frames with `requestFrame`: the globe draws only when asked. The built-in layers implement the same interface.

## Buildings

`@vibeglobe/layers/vector-tiles` extrudes vector-tile buildings (`buildingHeight`, `extrudeBuilding`). The height of a
building comes from its tags, in this order:

1. `height` (or OpenMapTiles' `render_height`), in metres; `m`, `ft` and `'` suffixes are read.
2. `building:levels` × 3 m (`LEVEL_HEIGHT_METERS`).
3. The default for its `building` (or `building:part`) type, below (`DEFAULT_BUILDING_HEIGHTS`).

The base comes from `min_height` (or `render_min_height`), else `building:min_level` × 3 m, else the ground. An
outline that contains `building:part` features, or carries `hide_3d`, is not extruded: its parts replace it. Heights
depend only on a building's tags, so a building has the same height in every tile and after every reload. On the flat
map, heights scale with the Web Mercator scale factor `1 / cos(latitude)` (`flatMapHeightScale`); measurements stay in
metres.

| `building`                                                            | Default height (m) |
| --------------------------------------------------------------------- | -----------------: |
| `house`, `detached`, `semidetached_house`, `retail`, `farm`           |                  6 |
| `terrace`                                                             |                  9 |
| `residential`, `commercial`, `public`, `civic`, `temple`              |                 12 |
| `apartments`, `mosque`, `university`, `train_station`                 |                 15 |
| `office`, `hotel`, `hospital`                                         |                 18 |
| `industrial`, `warehouse`, `chapel`, `barn`, `yes` and any other type |                  8 |
| `school`                                                              |                 10 |
| `church`                                                              |                 20 |
| `cathedral`                                                           |                 35 |
| `roof`, `greenhouse`                                                  |                  4 |
| `garage`, `garages`, `carport`, `shed`, `hut`                         |                  3 |

## Options

`DataLayerOptions`, shared by every built-in layer:

| Option               | Type                                                  | Default                      | Effect                                                            |
| -------------------- | ----------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------- |
| `id`                 | `string`                                              | generated                    | Unique within the stack                                           |
| `data`               | `FeatureCollection`, `Feature[]` or an async iterable | none                         | The features the layer starts with                                |
| `style`              | `LayerStyle`                                          | the specification's defaults | Properties and expressions                                        |
| `placement`          | `Placement`                                           | by kind (see Placement)      | Where features stand in height                                    |
| `minZoom`, `maxZoom` | `number`                                              | 0, 24                        | Draws for zoom in `[minZoom, maxZoom)`                            |
| `pickable`           | `boolean`                                             | `true`                       | Writes pick ids; `false` takes no pick slot                       |
| `draggable`          | `boolean`                                             | `false`                      | Features follow pointer drags                                     |
| `capacity`           | `number`                                              | 64                           | Features to reserve room for, so later ones add without a rebuild |
| `orderOffset`        | `number`, 0 to 15                                     | 0                            | Draw order within the layer's band                                |

## Rules and pitfalls

- `createGlobeLayers` must run after `globe.ready`: before it the globe has no layer target.
- Features need an `id` to be updated, selected or removed by the application; one without gets a generated id.
- Change features in place (`setFeaturePosition`, `updateFeature`, `setFeatureState`): `setStyle` re-evaluates every
  feature, and a new layer rebuilds its batch.
- An expression that reads both `['zoom']` and a feature property re-evaluates every feature at each zoom change. A
  zoom-only expression is evaluated once per frame for the whole layer, so large layers keep zoom out of per-feature
  expressions.
- `fill-extrusion-height` and `fill-extrusion-base` count only when the style sets them: polygons are flat otherwise.
- A layer is in one stack at a time. Removing it frees its batch, its pick slot and every event handler: subscribe
  again after adding it back.
- A stack holds at most 255 pickable layers, one pick slot each.
- A `GeoJsonLayer` reads a string as the data's text, not as a URL: pass `{ url }` or a `URL` to fetch.

## Errors

| Error or code                   | When                                                                                    | What to do                                   |
| ------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------- |
| `GlobeError` `'invalid-option'` | `createGlobeLayers` before `globe.ready`                                                | Await `globe.ready` first                    |
| `StyleError`                    | A property the kind does not read, or a malformed expression                            | Fix each entry of `problems`                 |
| `TypeError`                     | A feature without geometry or with invalid coordinates; a non-`Point` cluster feature   | Validate the data first                      |
| `Error`                         | A duplicate feature id; a layer id already in the stack; a layer in another stack       | Use unique ids                               |
| `RangeError`                    | `fitObjects` with nothing to frame; a 256th pickable layer                              | Check the input; set `pickable: false`       |
| `error` event                   | A `GeoJsonLayer` URL answers an error status, or features do not parse (one event each) | Show `message`; the layer keeps its features |

## See also

- [Models](models.md): glTF models as layer features, instanced model sets, 3D Tiles.
- [Vector tiles](vector-tiles.md): MapLibre styles from vector tiles.
- [UI and GIS](ui-and-gis.md): drawing and measurement tools on top of the layers.
