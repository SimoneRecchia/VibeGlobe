# Terrain

How to add terrain to a globe, query heights, keep the camera above the ground and host a geoid grid (M4; ADR 0006 §2–7, ADR 0027). The project serves no data (ADR 0015): you host the tiles and any geoid grid.

## Sources

Pass one terrain source and a worker pool to `createGlobe`; imagery drapes over it at its own levels (F140).

```ts
import { createGlobe } from '@vibeglobe/core';
import { createRenderer } from '@vibeglobe/renderer';
import { createWorkers } from '@vibeglobe/worker';
import { heightmapTerrain, quantizedMeshTerrain } from '@vibeglobe/sources';

const terrain = heightmapTerrain({
  id: 'terrain',
  url: 'https://tiles.example.com/terrarium/{z}/{x}/{y}.png',
  encoding: 'terrarium', // or 'terrain-rgb'
  maxLevel: 14,
});
// Or quantized-mesh, read from the tileset's layer.json (availability, extensions, tiling):
// const terrain = await quantizedMeshTerrain({ id: 'terrain', url: 'https://tiles.example.com/qm/layer.json' });

const globe = createGlobe({ container, renderer: createRenderer(), terrain, workers: createWorkers() });
```

- **Heightmaps** (`heightmapTerrain`): Terrarium (`(R × 256 + G + B / 256) − 32768` m) and Terrain-RGB (`−10000 + (R × 65536 + G × 256 + B) / 10` m), 256 or 512 px, Web Mercator or geographic, XYZ or TMS (`{-y}`), with an optional `coverage`.
- **Quantized-mesh** (`quantizedMeshTerrain`): gzip-compressed or not, with the oct-encoded normals, water mask and metadata extensions requested only when `layer.json` declares them. Tiles outside the declared availability, including availability declared in parent tiles' metadata, are never requested (F128).
- **Any other encoding** (F132): write a `TerrainSource` whose `decoder` is `{ kind: 'custom', decode(bytes, coord) }` and returns a `heightGrid(...)`. It runs between frames on the main thread, so keep it cheap; `apps/playground/src/terrain-adapters.ts` has two complete examples (a 24-bit RGB formula and raw float32 tiles).

Decoding, triangulation and gzip inflation run in the workers (F134). Corrupt tiles are reported through the `tile-error` event, and the area keeps its best ancestor (F131).

## Vertical datum

Every source declares what its heights are measured from: the WGS84 ellipsoid (the default) or a geoid, as Copernicus DEM uses EGM2008. Geoid heights H are converted to ellipsoidal heights h = H + N before meshing and queries, N interpolated bilinearly in a geoid grid you host (F133):

```ts
import { readGeoidFile } from '@vibeglobe/core';

const model = readGeoidFile(await (await fetch('/geoid/egm2008-15m.bin')).arrayBuffer());
const terrain = heightmapTerrain({ id: 'dem', url, encoding: 'terrarium', datum: { kind: 'geoid', model } });
```

The grid file is `VGEOID1` (`packages/core/src/terrain/geoid-file.ts`): a 16-byte header and float32 undulations, rows from 90° N to 90° S, columns eastward from 180° W. To make one from a published model, export its undulations as `latitude longitude undulation` lines on a regular grid (for example with GeographicLib's `GeoidEval`, MIT-licensed, over the nodes of a 15′ grid) and run:

```sh
node scripts/geoid-grid.ts convert egm2008-15m.txt egm2008-15m.bin
# Compare with published reference undulations (latitude longitude undulation per line); exits 1 beyond the tolerance.
node scripts/geoid-grid.ts check egm2008-15m.bin egm2008-reference.txt 1
```

Checking a real EGM2008 grid against published undulations needs the dataset download, an owner step (`docs/open-questions.md`, F133).

## Elevation queries

- `globe.elevationAt(position, out?)` answers at once from the terrain in memory: the deepest resident tile, interpolated as the surface shows it, with the level it came from. Without terrain there, it returns the ellipsoid (0 m) with `noData: true` (F144). Pass a reused `out` and position object in loops: a query allocates nothing, and 10,000 take a few milliseconds.
- `globe.elevationAtAsync(position, { signal })` loads the finest tiles available at the position first and resolves with their height. Each tile is requested once however many queries wait for it. The promise rejects with a `GlobeError` of code `aborted`, `resource-failed` or `destroyed`; it never hangs (F145).

## The camera above the terrain

Every frame, the camera keeps the eye `terrainClearanceMeters` (default 10 m) above the surface the frame shows, its morph included. When finer and higher terrain arrives, the eye rises with the morph over several frames instead of jumping (F146, F147). `globe.camera.groundHeightMeters` is that surface's height under the eye, and `eyeLongitudeDeg` and `eyeLatitudeDeg` give the eye's position.

## Diagnostics

- `globe.surfaceTiles()`: each tile's `terrainLevel` (an ancestor's while its own loads) and `terrainErrorPx`, which the selection keeps at or below 2 px (τ_terrain) above the source's last level (F126).
- `globe.terrainStats()`: the terrain loader's counters, the bytes uploaded in the last frame against `uploadBudgetBytes`, and `msLastFrame`, the main-thread time the last frame spent on terrain (budget in `docs/plan/quality.md`, F134).

## Picking terrain

`globe.screenToGeo(point)` returns the point of the terrain drawn under a screen point, with its height (F383). The pixel's
ray is intersected with the surface as the frame draws it (the globe-to-map morph and the relief scale included), then
moved to where the terrain's height meets it. Accuracy, as `e2e/terrain-picking.spec.ts` checks it in the globe, flat
and tilted views: the position lies within one screen pixel's size on the ground of the point drawn there, and the
height within 2 m plus one pixel of 45° slope of `globe.elevationAt` at that position. Heights come from the terrain in
memory: where the view draws no relief (the whole globe, the flat map) the terrain stays coarse, so the height is the
coarse level's; `globe.elevationAtAsync` loads the finest level first. Data-layer events (`click`, `hover-enter`)
carry the same position.
