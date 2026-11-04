# @vibeglobe/providers

Ready implementations of VibeGlobe's services for particular providers: `MapTilerTiles` and `MapTilerTerrain`
(MapTiler, with the application's key), `EsriTiles` (Esri's ArcGIS Online basemaps), `OpenFreeMapTiles`
(OpenFreeMap's vector maps), `PhotonGeocoder` (place search with Photon) and the OpenStreetMap sources
`openStreetMapImagery` and `openStreetMapHostedImagery`. The package is optional: an application may implement
`TileService`, `TerrainService` and `GeocoderService` itself for any other provider.

## Install

`@vibeglobe/core` and `@vibeglobe/sources` install with it; there are no peer dependencies.

## Entry points

| Import                 | What                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `@vibeglobe/providers` | `MapTilerTiles`, `MapTilerTerrain`, `EsriTiles`, `OpenFreeMapTiles`, `PhotonGeocoder`, OSM sources |

## Example

```ts
import { EsriTiles, PhotonGeocoder } from '@vibeglobe/providers';
import { createVibeGlobe } from 'vibeglobe';

await createVibeGlobe(container, { tiles: new EsriTiles({ map: 'imagery' }), geocoder: new PhotonGeocoder() });
```

## Pitfalls

- The application holds each provider's key, pays its plan and keeps to its terms; MapTiler and Esri tiles cannot go
  in offline packages, and their credits stay visible.
- `MapTilerTiles` and `MapTilerTerrain` throw a `SourceConfigError` `missing-key` without a key.
- komoot's public Photon instance is for light use; pass `url` for your own instance. Names come in German, English or
  French when the controls use one of them, else in the local language.

See the [services guide](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/services.md).
