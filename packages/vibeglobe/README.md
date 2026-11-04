# vibeglobe

VibeGlobe in one call. `createVibeGlobe` starts a 3D globe and 2D map in an element with the application's services:
a `TileService` (required), a `TerrainService` and a `GeocoderService` (optional). It sets up the renderer (WebGPU,
else WebGL2), the workers, navigation and the ready-made controls. The engine knows no map provider: any provider plugs
in by implementing the interfaces, or through the ready implementations of `@vibeglobe/providers`.

## Install

`@vibeglobe/core`, `controls`, `layers`, `renderer`, `ui` and `worker` install with it; there are no peer
dependencies.

## Entry points

| Import      | What                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------- |
| `vibeglobe` | `createVibeGlobe`, and the types `TileService`, `TerrainService`, `GeocoderService`, `Globe` |

## Example

```ts
import { xyzImagery } from '@vibeglobe/sources';
import { createVibeGlobe, type TileService } from 'vibeglobe';

const tiles: TileService = {
  imagery: () => [xyzImagery({ id: 'osm', url: 'https://tiles.example.com/{z}/{x}/{y}.png', maxLevel: 19 })],
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
