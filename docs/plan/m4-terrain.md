# M4 Terrain: implementation plan

Feature entries F126–F148. Design: [ADR 0006](../adr/0006-level-of-detail.md) §2–§7 (selection, fallback, transitions, terrain geometry, cracks, poles), [ADR 0007](../adr/0007-scheduling-and-caching.md) (requests and memory), [ADR 0011](../adr/0011-workers.md) (workers), [ADR 0004](../adr/0004-precision-strategy.md) (precision). Survey: [level of detail](../research/level-of-detail.md) §3.8 (Martini, Delatin).

## 1. Scope and order of work

Each increment ends with its features passing end to end, committed and pushed.

1. **Decoders (F127–F133).** Pure functions in `@vibeglobe/worker`, each returning a `HeightGrid` (float32 heights on a (2^k+1)² grid, min, max, decimation error per grid size):
   - quantized-mesh (header, zig-zag deltas, high-water-mark indices in 16 and 32 bits, edge lists, extensions skipped by length), rasterized to the grid;
   - `layer.json` reader (scheme, zoom range, available ranges, extensions, child availability metadata);
   - Terrarium and Terrain-RGB PNG decoders (256 and 512 px), clamped within their own pixels;
   - a public `TerrainAdapter` interface for any other encoding (F132), shown with a raw float32 adapter in the tests;
   - a vertical datum on every source; geoid heights converted to WGS84 ellipsoidal heights with a geoid grid the consumer hosts (ADR 0026; the project ships no dataset, ADR 0015). Checking the real EGM2008 grid needs its download, an owner step: F133 becomes `pending` once its other steps pass.
   - Fuzzing (F131) reuses M3's decoder fuzz harness with the terrain tasks added.
2. **Terrain tiles in the loader (F126, F134, F139, F142).** The imagery loader, with its decode step taken from the source, loads a terrain layer next to the imagery layers, with its own source tiling and levels, chosen by the terrain error rule of ADR 0006 §2. Height grids are decoded in workers and uploaded as float textures within the upload budget; bounding volumes and horizon culling use each tile's min and max heights. A missing tile samples its best resident ancestor.
3. **Displaced surface (F135, F136, F137, F143).** The vertex shader reads heights (`texelFetch` / `textureLoad`) and displaces along the ellipsoid normal; tile-center-relative positions keep street-level vertices still. Skirts follow ADR 0006 §6 (2 × (tile + parent error), at least the edge sagitta). The antimeridian and the caps reuse M3's surface (Mercator-only terrain continues its last heights into the caps).
4. **Geomorphing and independent levels (F138, F140, F141).** Terrain heights use the same from/to pairs and 250 ms transitions as imagery (M3 `ImageryFades`), mixed in the vertex shader, so relief never pops. Imagery keeps its own levels and is mapped per vertex across schemes.
5. **Elevation queries (F144, F145).** A synchronous query on resident heights returns the height and its level; an asynchronous one loads the finest available tile. Both use the TypeScript reference of the shader's interpolation.
6. **Camera and terrain (F146, F147).** The camera controller keeps a minimum clearance above the displayed surface (synchronous query under the eye and the orbit target) and lifts the camera smoothly when finer terrain arrives above it.
7. **Acceptance (F148).** Scenario tests on both backends with the fixture terrain: a crack sweep (all tilts, level boundaries), an alpine flight (relief matches source heights, no pops, no black or background pixels), horizon peaks (no culled relief), and camera collision. One milestone review, one fix-only pass, the full CI run, the merge.

## 2. Fixtures

- The fixture tile server serves synthetic terrain in all three encodings from one analytic height function (smooth hills plus a sharp ridge and a 4,000 m peak), so tests compare rendered relief with exact heights.
- `layer.json` fixtures cover availability ranges, metadata in child tiles and unknown extensions.
- No real dataset is downloaded (Copernicus DEM stays an owner step for M9).

## 3. Risks

- Float textures for heights: WebGL2 needs `R32F` without filtering (the shader interpolates itself, so no extension is needed).
- Vertex cost of 64² grids on the software rasterizer of CI: the grid size follows the measured error, and scenario viewports stay at 800 × 600.
- Geoid grid: a 1° grid is about 130 KB as int16; the consumer hosts it and it loads only for sources that declare a geoid datum.
