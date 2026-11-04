# vibeglobe

VibeGlobe, a 3D globe and 2D map engine for the web (WebGPU with a WebGL2 fallback), in one package. `createVibeGlobe`
starts it in an element with the application's services: a `TileService` (required), a terrain and a
`GeocoderService` (optional). It sets up the renderer, the workers, navigation and the ready-made controls. Every part
of the engine is a subpath of this package (`vibeglobe/core`, `vibeglobe/sources`, `vibeglobe/vue`, …), and the bundler
takes only the subpaths imported. VibeGlobe ships no map and no provider: any provider plugs in through the generic
sources.

## Install

`npm install vibeglobe`: one package holds the whole engine, one subpath for each part; `vue` 3.5 or later is a peer
dependency of `vibeglobe/vue` only.

## Entry points

| Import                    | What                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `vibeglobe`               | `createVibeGlobe`, and the types `TileService`, `TerrainSource`, `GeocoderService`, `Globe` |
| `vibeglobe/core`          | `createGlobe`, the camera, tiling, streaming, events, geodesy, the service interfaces       |
| `vibeglobe/renderer`      | The WebGPU and WebGL2 backends; `/gltf`, `/vector-tiles`, `/tiles3d`, `/starfield`          |
| `vibeglobe/sources`       | Generic imagery, terrain, vector and 3D sources (XYZ, WMS, WMTS, PMTiles, MBTiles, …)       |
| `vibeglobe/worker`        | The worker pool that decodes tiles and models off the main thread                           |
| `vibeglobe/controls`      | Mouse, touch, trackpad and keyboard navigation                                              |
| `vibeglobe/layers`        | Application data: markers, labels, lines, polygons, models; `/vector-tiles`, `/models`      |
| `vibeglobe/ui`            | Ready-made controls, themes and translations                                                |
| `vibeglobe/vue`           | Vue 3 components and composables (needs `vue` 3.5 or later)                                 |
| `vibeglobe/web-component` | The `<vibe-globe>` custom element                                                           |
| `vibeglobe/offline`       | Network modes, the browser tile cache, offline packages                                     |
| `vibeglobe/gis`           | Coordinates, reference systems, measurement, view state                                     |
| `vibeglobe/quality`       | Quality presets and the adaptive frame-time governor                                        |
| `vibeglobe/models`        | glTF 2.0 and GLB parsing, Draco and meshopt decoding                                        |
| `vibeglobe/tools`         | The data pipeline and offline package builder (`npx vibeglobe-data`)                        |

The guides matching the installed version are in `node_modules/vibeglobe/docs/guides/`, indexed by
`node_modules/vibeglobe/llms.txt`.

## Example

```ts
import { xyzImagery } from 'vibeglobe/sources';
import { createVibeGlobe, type TileService } from 'vibeglobe';

const tiles: TileService = {
  imagery: [xyzImagery({ id: 'osm', url: 'https://tiles.example.com/{z}/{x}/{y}.png', maxLevel: 19 })],
};
const { globe } = await createVibeGlobe(container, {
  tiles,
  view: { longitudeDeg: 9.19, latitudeDeg: 45.46, zoom: 11 },
});
console.log(globe.backend);
```

## Pitfalls

- `tiles` is required: without it the promise rejects with a `GlobeError` `invalid-option`.
- A missing `terrain` leaves the surface flat and a missing `geocoder` leaves the search box for coordinates; neither
  is an error.
- The promise resolves after the first frame and the tile service's style; a style that fails to load rejects it.

See the [services guide](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/services.md).
