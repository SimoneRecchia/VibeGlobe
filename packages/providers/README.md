# @vibeglobe/providers

Ready services of VibeGlobe for particular providers: `mapTilerTiles` and `mapTilerTerrain` (MapTiler, with the
application's key), `esriTiles` (Esri's ArcGIS Online basemaps), `openFreeMapTiles` (OpenFreeMap's vector maps),
`photonGeocoder` (place search with Photon) and the OpenStreetMap sources `openStreetMapImagery` and
`openStreetMapHostedImagery`. The package is optional: an application may write its own `TileService`, terrain source
and `GeocoderService` for any other provider.

## Install

`@vibeglobe/core` and `@vibeglobe/sources` install with it; there are no peer dependencies.

## Entry points

| Import                 | What                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `@vibeglobe/providers` | `mapTilerTiles`, `mapTilerTerrain`, `esriTiles`, `openFreeMapTiles`, `photonGeocoder`, OSM sources |

## Example

```ts
import { esriTiles, photonGeocoder } from '@vibeglobe/providers';
import { createVibeGlobe } from 'vibeglobe';

await createVibeGlobe(container, { tiles: esriTiles(), geocoder: photonGeocoder() });
```

## Pitfalls

- The application holds each provider's key, pays its plan and keeps to its terms; MapTiler and Esri tiles cannot go
  in offline packages, and their credits stay visible.
- `mapTilerTiles` and `mapTilerTerrain` throw a `SourceConfigError` `missing-key` without a key.
- komoot's public Photon instance is for light use; pass `url` for your own instance. Names come in German, English or
  French when the controls use one of them, else in the local language.

See the [services guide](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/services.md).
