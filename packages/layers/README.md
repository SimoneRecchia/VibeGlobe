# @vibeglobe/layers

Application data on a VibeGlobe globe: points, markers, labels, lines, polygons, extrusions and geodesic circles from
GeoJSON, KML or GPX, styled with MapLibre Style Specification properties and expressions, clustered, picked, dragged
and updated one feature at a time. Its subpaths add glTF models as layer features and MapLibre styles over vector
tiles. An application needs it to show its own data, models or a vector map on the globe.

## Install

`@vibeglobe/core` and `@vibeglobe/sources` install with it; there are no peer dependencies. Drawing needs a globe
with `@vibeglobe/renderer`: its `@vibeglobe/renderer/gltf` entry for models, its `@vibeglobe/renderer/vector-tiles`
entry for vector tiles.

## Entry points

| Import                             | What                                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `@vibeglobe/layers`                | `createGlobeLayers`, `DataLayer`, `LabelLayer`, `ClusterLayer`, `GeoJsonLayer`, `fitObjects` |
| `@vibeglobe/layers/models`         | `ModelLayer` and `ModelSetLayer`: glTF models as features                                    |
| `@vibeglobe/layers/vector-tiles`   | `addVectorTiles`, `VectorStyle`, building heights                                            |
| `@vibeglobe/layers/cluster-worker` | `workerClusterEngine`: a `ClusterLayer` index built in a worker                              |
| `@vibeglobe/layers/testing`        | `RecordingRenderTarget`: a render target that records uploads, for tests                     |

## Example

```ts
import type { Globe } from '@vibeglobe/core';
import { createGlobeLayers, DataLayer } from '@vibeglobe/layers';

declare const globe: Globe;

await globe.ready;
const { stack } = createGlobeLayers(globe, { element: container });
const sites = stack.add(
  new DataLayer('point', {
    id: 'sites',
    data: [{ type: 'Feature', id: 'a', properties: {}, geometry: { type: 'Point', coordinates: [12.5, 41.9] } }],
    style: { 'circle-color': '#e03020', 'circle-radius': 6 },
  }),
);
sites.on('click', ({ feature }) => sites.setFeatureState(feature.id, { selected: true }));
```

## Pitfalls

- `createGlobeLayers` throws a `GlobeError` before `globe.ready`.
- A style property the layer's kind does not read throws a `StyleError`.
- Change features in place (`setFeaturePosition`, `updateFeature`, `setFeatureState`) instead of rebuilding a layer.
- Removing a layer from its stack drops its event handlers.
- Models need `createRenderer({ gltf })`; vector tiles need `target: createVectorTileTarget`.

## Guides

- [Data layers](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/data-layers.md)
- [3D models](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/models.md)
- [Vector tiles](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/vector-tiles.md)
