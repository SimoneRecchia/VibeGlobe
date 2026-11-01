---
title: Terrain
---

# Terrain

A globe takes one terrain source in `GlobeOptions.terrain` and displaces its surface to the source's heights; imagery
drapes over it at its own levels. The adapters are in `@vibeglobe/sources`, geoid grids are read with
`@vibeglobe/core/decoders`, and the heights are queried on the `Globe`. You host the tiles and any geoid grid
([hosting guide](hosting.md)); every adapter and its options are in the [sources guide](sources.md#terrain-adapters).

## Quick start

```ts
import { createGlobe } from '@vibeglobe/core';
import { createRenderer } from '@vibeglobe/renderer';
import { heightmapTerrain } from '@vibeglobe/sources';
import { createWorkers } from '@vibeglobe/worker';

const terrain = heightmapTerrain({
  id: 'terrain',
  url: 'https://tiles.example.com/terrarium/{z}/{x}/{y}.png',
  encoding: 'terrarium', // or 'terrain-rgb'
  maxLevel: 14,
});
const globe = createGlobe({
  container,
  renderer: createRenderer(),
  baseImageryUrl: '/static/vibeglobe/fallback-base.jpg',
  terrain,
  workers: createWorkers(),
});
```

Without `terrain` the surface is the WGS84 ellipsoid. Where the source has no data the surface stays on the ellipsoid.

## Sources

- **Heightmaps** (`heightmapTerrain`): Terrarium (`(R × 256 + G + B / 256) − 32768` m) and Terrain-RGB
  (`−10000 + (R × 65536 + G × 256 + B) / 10` m) PNG tiles, 256 or 512 px, Web Mercator or geographic (`tiling`), XYZ or
  TMS (`{-y}`), levels 0 to 15 by default. `coverage` (rectangles in radians) or `area` (polygons in degrees, tiles
  wholly inside) limits the requests.
- **Quantized-mesh** (`quantizedMeshTerrain({ id, url })`, `url` naming `layer.json`): gzip-compressed or not. The
  oct-encoded normals, water mask and metadata extensions are requested only when `layer.json` declares them. Tiles
  outside the declared availability, including availability declared in parent tiles' metadata, are never requested.
- **Packages** (`pmtilesTerrain`, `mbtilesTerrain`): the same encodings in a PMTiles archive or an MBTiles package.
- **Any other encoding**: a `TerrainSource` whose `decoder` is `{ kind: 'custom', decode(bytes, coord) }`, returning a
  `heightGrid(pixelHeights, sizePx, cells)` of `@vibeglobe/core/decoders` and throwing on undecodable bytes. It runs on
  the main thread between frames, so keep it cheap. The playground's
  [terrain adapters](https://github.com/SimoneRecchia/VibeGlobe/blob/main/apps/playground/src/terrain-adapters.ts)
  are two complete examples (a 24-bit RGB formula and raw float32 tiles).

The built-in decoders, triangulation and gzip inflation run in the workers. A corrupt tile is reported through the
`tile-error` event, and its area keeps its best ancestor.

## Vertical datum

Every source declares what its heights are measured from: the WGS84 ellipsoid (the default) or a geoid, as Copernicus
DEM uses EGM2008. Geoid heights H become ellipsoidal heights h = H + N before meshing and queries, with N interpolated
bilinearly in a geoid grid you host:

```ts
import { readGeoidFile } from '@vibeglobe/core/decoders';
import { heightmapTerrain } from '@vibeglobe/sources';

const model = readGeoidFile(await (await fetch('/geoid/egm2008-15m.bin')).arrayBuffer());
const terrain = heightmapTerrain({
  id: 'dem',
  url: 'https://tiles.example.com/copernicus/{z}/{x}/{y}.png',
  encoding: 'terrarium',
  datum: { kind: 'geoid', model },
});
```

The grid file is `VGEOID1`: the 8-byte magic `VGEOID1\0`, the row and column counts as little-endian uint32, then
rows × columns little-endian float32 undulations in metres, rows from 90° N to 90° S inclusive, columns eastward from
180° W. `readGeoidFile` throws a `RangeError` naming the problem for any other file. To make one from a published
model, export its undulations as `latitude longitude undulation` lines on a regular grid (for example with
GeographicLib's `GeoidEval`, MIT-licensed, over the nodes of a 15′ grid) and run the repository's
[`scripts/geoid-grid.ts`](https://github.com/SimoneRecchia/VibeGlobe/blob/main/scripts/geoid-grid.ts):

```sh
node scripts/geoid-grid.ts convert egm2008-15m.txt egm2008-15m.bin
# Compares with reference undulations (latitude longitude undulation per line); exits 1 beyond the tolerance (default 1 m).
node scripts/geoid-grid.ts check egm2008-15m.bin egm2008-reference.txt 1
```

## Elevation queries

```ts
import type { ElevationSample, Globe } from '@vibeglobe/core';

declare const globe: Globe;

const sample: ElevationSample = { heightMeters: 0, level: -1, noData: true };
globe.elevationAt({ longitudeDeg: 7.66, latitudeDeg: 45.98 }, sample); // at once, from the tiles in memory
const finest = await globe.elevationAtAsync({ longitudeDeg: 7.66, latitudeDeg: 45.98 }); // loads the finest tile first
```

- `elevationAt(position, out?)` answers from the deepest resident tile, interpolated as the surface shows it, with the
  `level` it came from. Without terrain there it returns 0 m with `noData: true`. With a reused `out` a query
  allocates nothing; 10,000 queries take a few milliseconds.
- `elevationAtAsync(position, { signal })` loads the finest tile at the position first. Each tile is requested once
  however many queries wait for it. Without terrain it resolves with 0 m and `noData: true`.

## The camera above the terrain

Every frame the eye stays `terrainClearanceMeters` (default 10 m) above the surface the frame shows, its morph
included. When finer, higher terrain arrives, the eye rises with the morph over several frames instead of jumping.
`globe.camera.groundHeightMeters` is that surface's height under the eye; `eyeLongitudeDeg` and `eyeLatitudeDeg` give
the eye's position.

## Diagnostics

- `globe.surfaceTiles()`: each tile's `terrainLevel` (an ancestor's while its own loads, `null` without terrain) and
  `terrainErrorPx`, which the selection keeps at or below 2 px above the source's last level.
- `globe.terrainStats()`: the terrain loader's counters, the bytes uploaded in the last frame against
  `uploadBudgetBytes`, and `msLastFrame`, the main-thread time the last frame spent on terrain; `undefined` without
  terrain.

## Picking terrain

`globe.screenToGeo(point)` returns the point of the terrain drawn under a screen point, with its height. The pixel's
ray meets the surface as the frame draws it (the globe-to-map morph and the relief scale included), then moves to where
the terrain's height meets it. The position lies within one screen pixel's size on the ground of the point drawn
there, and the height within 2 m plus one pixel of 45° slope of `globe.elevationAt` at that position. Heights come from
the terrain in memory: where the view draws no relief (the whole globe, the flat map) the terrain stays coarse;
`globe.elevationAtAsync` loads the finest level. Data-layer events (`click`, `hover-enter`) carry the same position.

## Rules and pitfalls

- A globe has one terrain source; `createGlobe` needs `workers` to load it.
- `heightmapTerrain` does not check its URL template: a wrong field shows as failed tiles in `tile-error`.
- A geoid-referenced DEM (Copernicus DEM) without its `datum` is off by the geoid undulation, up to about 100 m.
- A source whose profile is `displayOnly` refuses elevation sampling with a `GlobeError` of code `display-only`.
- A custom `decode` runs on the main thread: a slow one stalls frames.

## Errors

| Error or code                     | When                                                                          | What to do                                       |
| --------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------ |
| `GlobeError` `invalid-coordinate` | `elevationAt` with an invalid position, `screenToGeo` with a non-finite point | pass finite values, latitude within ±90°         |
| `GlobeError` `resource-failed`    | `elevationAtAsync`: the finest tile failed for good                           | use `elevationAt`, or retry later                |
| `GlobeError` `aborted`            | `elevationAtAsync`: its `signal` aborted                                      | nothing                                          |
| `GlobeError` `destroyed`          | `elevationAtAsync`: the globe was destroyed first                             | nothing                                          |
| `GlobeError` `display-only`       | elevation sampling of a display-only source                                   | the provider's terms forbid it                   |
| `RangeError`                      | `readGeoidFile` on a file that is not `VGEOID1`                               | regenerate the grid with `scripts/geoid-grid.ts` |
| `Error`                           | `quantizedMeshTerrain` when `layer.json` cannot be loaded or read             | check the URL and CORS                           |

## See also

- [Sources and adapters](sources.md#terrain-adapters): the terrain adapters and their options.
- [Hosting](hosting.md): serving terrain tiles and the geoid grid.
- [Offline packages](offline.md): terrain packages need `pmtilesArchive(o, 'any')` adapters.
