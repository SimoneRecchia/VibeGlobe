# @vibeglobe/sources

Source adapters for the globe's tiled layers: imagery from XYZ and TMS templates, WMTS, WMS, PMTiles and MBTiles
packages, single georeferenced images and client-side reprojection; terrain from Terrarium, Terrain-RGB and
quantized-mesh tiles; vector tiles from packages; GeoJSON, KML, GPX and MVT parsers; OGC 3D Tiles. Each adapter
carries its credits and its provider profile, and `fetchTransport` keeps keys and tokens out of the URLs the engine
sees. Every application that draws imagery or terrain needs it.

## Install

Needs `@vibeglobe/core`, plus `fflate`, `pbf`, `pmtiles`, `sql.js` and `txml` (dependencies). Reprojection takes
transforms from `@vibeglobe/gis` (`transformCoordinates`), which the application installs when it needs them.

## Entry points

| Import path                      | What                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| `@vibeglobe/sources`             | Imagery, terrain and package adapters, `fetchTransport`, `withProfile`, OpenStreetMap         |
| `@vibeglobe/sources/mbtiles`     | `mbtilesImagery`, `mbtilesTerrain`, `mbtilesVector`, `mbtilesArchive` (SQLite as WebAssembly) |
| `@vibeglobe/sources/geotiff`     | `geotiffImage`, `readGeotiff`                                                                 |
| `@vibeglobe/sources/vector`      | `parseGeoJson`, `parseKml`, `parseGpx`, `decodeMvt`, `VECTOR_TASKS`                           |
| `@vibeglobe/sources/tiles3d`     | `tiles3d`, the 3D Tiles render extension, and its parsers                                     |
| `@vibeglobe/sources/conformance` | `runTiledConformance`, `runTerrainConformance`, `runParserConformance`, `failures`            |
| `@vibeglobe/sources/tile-mask`   | The per-pixel area mask of the worker's image decoder                                         |

## Example

```ts
import { createGlobe } from '@vibeglobe/core';
import { heightmapTerrain, xyzImagery } from '@vibeglobe/sources';
import { createWorkers } from '@vibeglobe/worker/basic';

createGlobe({
  container,
  renderer,
  baseImageryUrl: '/static/vibeglobe/fallback-base.jpg',
  workers: createWorkers(),
  imagery: [xyzImagery({ id: 'base', url: 'https://tiles.example.com/{z}/{x}/{y}.png', maxLevel: 18 })],
  terrain: heightmapTerrain({ id: 'dem', url: 'https://dem.example.com/{z}/{x}/{y}.png', encoding: 'terrarium' }),
});
```

## Pitfalls

- `coverage` is in radians, `area` in degrees; a plain `area: { polygons }` requests only tiles wholly inside it.
- A profile's `forbids` takes effect only for sources wrapped by `offline.source()` of `@vibeglobe/offline`.
- `mbtilesImagery` needs `wasmUrl`, the URL where the application hosts `sql-wasm.wasm` of `sql.js`, and downloads the
  whole package before it resolves.
- Tiles on another origin need CORS headers; without them the engine logs one error and stops requesting the source.

## Guides

[Sources and adapters](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/sources.md),
[Terrain](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/terrain.md),
[Hosting](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/hosting.md).
