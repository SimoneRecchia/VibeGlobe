# Data pipeline tooling

- Status: Complete (survey for M9, F330)
- Date: 2026-10-21
- Decision: [ADR 0023](../adr/0023-data-pipeline.md)

## 1. Scope and requirements

This survey covers how existing tools turn source rasters and OpenStreetMap data into terrain, imagery and vector tiles, and how they package them. It looks at:

- how tiles are cut and resampled: pixel-is-area or pixel-is-point, edge handling, overlap pixels for terrain;
- height encodings: quantized-mesh, Terrain-RGB and Terrarium;
- PMTiles writing: directory layout, deduplication, clustering, determinism;
- how outputs stay reproducible.

It serves the M9 entries of `feature_list.json`:

- F331: a TypeScript pipeline driven by versioned configs, with external tools only in a Docker image pinned by digest;
- F335: resumable builds with integrity checks;
- F336: PMTiles, MBTiles and static folders;
- F337: license and attribution metadata.

It also serves ADR 0006 §5–6, which decodes Terrarium "within its own pixels" and hides cracks with skirts. `packages/tools` belongs to the parallel session (`docs/parallel-tracks.md`). This survey only informs ADR 0023.

## 2. Projects studied

Shallow clones, read but not run.

| Project                                      | Version / commit                          | License              | Files read                                                                                                                                            |
| -------------------------------------------- | ----------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| cesium-terrain-builder (heightmap, upstream) | `master` [`8dd633c`][ctb] (2018)          | Apache-2.0           | `src/{TerrainTiler.hpp,TerrainTiler.cpp,GDALTiler.cpp,GDALTiler.hpp}`, `CMakeLists.txt`, `README.md`                                                  |
| cesium-terrain-builder, quantized-mesh fork  | `master-quantized-mesh` [`7440667`][ctbq] | Apache-2.0           | `src/{MeshTiler.cpp,MeshTile.cpp,HeightFieldChunker.hpp,GDALDatasetReader.cpp}`, `tools/ctb-tile.cpp`                                                 |
| cesium-terrain-builder-docker                | [`b673ac4`][ctbd]                         | Apache-2.0           | `Dockerfile`, `Dockerfile.alpine`                                                                                                                     |
| Martini                                      | 0.2.0, [`f9a7a96`][mar]                   | ISC                  | `index.js`, `test/{test,util}.js`, `README.md`                                                                                                        |
| Delatin                                      | 0.2.0, [`9bb2f34`][del]                   | ISC                  | `index.js`, `test/test.js`, `README.md`                                                                                                               |
| go-pmtiles                                   | `main` [`a3e4951`][gop]                   | BSD-3-Clause         | `pmtiles/{convert,directory,cluster}.go`, `pmtiles/{directory,convert}_test.go`                                                                       |
| PMTiles spec                                 | v3, [`aec8fa1`][pms]                      | CC0 spec, BSD-3 code | `spec/v3/spec.md`                                                                                                                                     |
| GDAL `gdal2tiles.py`                         | `master` [`940f719`][g2t]                 | MIT                  | `swig/python/gdal-utils/osgeo_utils/gdal2tiles.py` (query sizes, `scale_query_to_tile`, `geo_query`, `create_overview_tile`, `--legacy`)              |
| rio-rgbify                                   | 0.4.0, [`a05815d`][rgb]                   | MIT                  | `rio_rgbify/{encoders,mbtiler}.py`, `test/`                                                                                                           |
| tippecanoe (Felt)                            | 2.82.0, [`4f26211`][tip]                  | BSD-2-Clause         | `pmtiles_file.cpp`, `mbtiles.cpp` (metadata), `README.md` (buffer, clipping), `Makefile` (tests)                                                      |
| Planetiler                                   | `main` [`d88cf89`][pt]                    | Apache-2.0           | `pmtiles/WriteablePmtiles.java`, `archive/TileArchiveWriter.java`, `render/{TiledGeometry,FeatureRenderer}.java`, `VectorTile.java`, `util/Gzip.java` |

## 3. How each project solves it

**cesium-terrain-builder (CTB).**

- **Grid:** heightmap tiles are 65 × 65 (`TERRAIN_TILE_SIZE 65`) on the geodetic grid. In [`terrainTileBounds`][ctb-tb] the resolution is `width / (65 − 1)`, and the warp window is extended one pixel west and north. After warping, the geotransform is reset to the tile bounds.
- **Effect:** the first and last samples of neighboring tiles coincide, so edges are shared. The sample lattice is offset half a cell north-west of the tile corners, because a GDAL pixel-is-area window was used for corner-style samples.
- **Resampling:** each tile is a `GDALCreateWarpedVRT`. The default algorithm is `GRA_Average` ("recommended by GDAL maintainer"), and `-r` selects others.
- **Quantized-mesh fork:** used by the tum-gis Docker image.
  - [`MeshTiler.cpp`][ctbq-mt] turns the 65 × 65 grid into a mesh with Ulrich's chunked-LOD chunker. The error target is Cesium's heightmap estimate × `--mesh-qfactor` ÷ 2^z.
  - To keep borders consistent, above zoom 6 it warps all four neighbor tiles again and activates their border vertices (`applyBorderActivationState`). Each tile therefore costs five warps.
  - [`MeshTile.cpp`][ctbq-mesh] quantizes u, v and h to 0–32767 with `round`, then writes zig-zag deltas.
  - Edge vertex lists are found by exact floating-point equality with the bound. Integers are written in native byte order.
  - The switch to 32-bit indices is `vertexCount > BYTESPLIT` with `BYTESPLIT = 65636`. The spec boundary is 65536, so a mesh with 65537–65636 vertices would get overflowing 16-bit indices. This cannot happen with 65 × 65 grids, but it can with larger ones.
- **Docker image:** [`Dockerfile`][ctbd] clones the `master-quantized-mesh` branch at its current head and uses unpinned `debian:buster` bases. Two builds of the same image tag can therefore differ.

**Martini (RTIN).**

- **Grid:** needs a (2^k + 1)² grid and throws otherwise.
- **Error and mesh:** [`index.js`][mar-js] precomputes, for each right-triangle midpoint, the maximum interpolation error of that triangle and its children. `getMesh(maxError)` walks the implicit binary tree.
- **Edges:** shared edges between tiles are not handled. The test helper [`mapboxTerrainToGrid`][mar-util] turns a 256-pixel Terrain-RGB tile into 257² by copying the last row and column. This edge is not shared with the neighbor, which is exactly where seams come from ([#7][mar7], [#23][mar23]).

**Delatin.**

- **Algorithm:** Garland–Heckbert greedy insertion ([`index.js`][del-js]) on any w × h grid. It rasterizes each new triangle to find the point with the largest error, then inserts that point.
- **Output:** fewer triangles than RTIN for the same error. The result depends on the order of insertion, but it is deterministic for the same input.
- **Edges:** borders start with only the four corners, so neighboring tiles refine their edges independently. Skirts are the open request ([#2][del2]).

**GDAL `gdal2tiles.py`.**

- **Base tiles:** read from a warped VRT. `geo_query` snaps the tile's georeferenced window to integer source pixels (`int(... + 0.001)` for the origin, `int(... + 0.5)` for the size).
- **Query size:** the window is read at `querysize` = 4 × tile size (2× for bilinear, 1× for nearest). It is then reduced with `gdal.RegenerateOverview` (average) or a `gdal.Warp` into the tile. Pixels are treated as areas. There is no overlap and no neighbor data.
- **Overview tiles:** [`create_overview_tile`][g2t-ov] mosaics the four child tiles **after they were encoded** to PNG or JPEG, then downsamples. Lossy formats lose quality at every level.
- **Default path:** since GDAL 3.13 the script delegates to `gdal raster tile` by default. Legacy mode is removed in 3.15 ([`--legacy` help][g2t-leg]), so tiling behavior depends on the GDAL version.

**rio-rgbify (Terrain-RGB).**

- **Tiles:** [`_tile_worker`][rgb-mt] reprojects each 512 × 512 Web Mercator tile independently from the source with `Resampling.bilinear`, sampling at pixel centers. There is no prefilter, so low zooms alias.
- **Encoding:** [`data_to_rgb`][rgb-enc] computes `(h − base) / interval` and rounds with `np.around`, which rounds half to even. It then splits the value into three bytes. Mapbox's convention is base −10000 and interval 0.1.
- **Order:** results arrive through `Pool.imap_unordered` and are inserted into MBTiles in completion order. The file bytes therefore depend on scheduling.

**Terrarium.** The encoding stores `h + 32768` as R · 256 + G + B / 256 in metres. It has 1/256 m steps over −32768 to 32767.996 m and needs no scale parameters. Terrain-RGB has 0.1 m steps and depends on its base and interval being agreed ([rio-rgbify #45][rgb45]).

**PMTiles writers.**

- **Spec ([spec][pms-spec]):** the header plus the compressed root directory must fit in the first 16384 bytes. TileIDs follow a Hilbert curve per zoom, accumulated from zoom 0. `Clustered` means tile data appears in TileID order, and deduplicated entries may point back to earlier offsets.
- **go-pmtiles:**
  - [`convert.go`][gop-conv] collects every TileID from MBTiles into a roaring bitmap and writes tiles in ascending order. It deduplicates by **FNV-128a** of the tile bytes, run-length encodes consecutive identical tiles, and gzips uncompressed MVT.
  - [`BuildDirectories`][gop-dir] puts everything in the root when there are fewer than 16384 entries. Otherwise it starts with leaves of max(4096, n / 3500) entries and grows them by 1.2× until the gzipped root fits.
- **Planetiler:** writes tiles in tile order from parallel encoders that are sequenced on purpose ([`TileArchiveWriter`][pt-taw]). It hashes only tiles that are likely duplicates (`likelyToBeDuplicated`, mostly ocean), using **64-bit FNV-1a** with no byte comparison ([`WriteablePmtiles`][pt-wp]).
- **tippecanoe:** writes MBTiles with a content-hash column, then converts it to PMTiles ([`pmtiles_file.cpp`][tip-pm]). It sorts TileIDs, deduplicates by that hash, and sets `clustered`.
- **Run-to-run variation:** tippecanoe stores `generator_options`, the full command line including local paths ([`mbtiles.cpp`][tip-mb]). Directory and metadata gzip depends on the zlib in use.

**Vector tiles.**

- **tippecanoe:** clips to the tile plus a buffer, 5/256 of the tile by default (`-b`). `--no-clipping` and `--no-duplication` trade correctness for size.
- **Planetiler:** clips with a stripe algorithm adapted from geojson-vt ([`TiledGeometry`][pt-tg]), with a buffer per feature. It rounds to the 4096 extent and repairs invalid polygons with JTS `buffer(0)` after rounding ([`FeatureRenderer`][pt-fr]).

## 4. Known failure modes from issue trackers

| Area            | Issue                                 | Symptom                                                                 | Root cause                                                                | Lesson                                                                    |
| --------------- | ------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Seam            | [martini #7][mar7]                    | Visible seams between RTIN tiles; averaging edges stretched textures    | Independent edge vertices per tile                                        | Shared edge samples in the data; skirts in the renderer                   |
| Seam            | [martini #23][mar23]                  | No way to use 258 × 258 tiles with a one-pixel border                   | 2^k + 1 grids only                                                        | Decide the border convention in the format, not in each consumer          |
| Seam            | [CTB #86][ctb86]                      | Walls at quantized-mesh tile boundaries                                 | LOD chose different edge vertices; neighbor checks only above zoom 6      | Make edge decisions a function of shared data only                        |
| Seam            | [CTB #5][ctb5]                        | Black gaps and walls on global tiles; negative seabed wrong             | Antimeridian and pole overlap; `uint16` heights                           | Signed encoding; test poles and the antimeridian                          |
| Seam            | [CTB #71][ctb71]                      | Gaps where a finer dataset was tiled over a coarser one                 | Source extent not aligned to the tile grid                                | Build every zoom from one mosaic; never merge pyramids                    |
| Seam            | [GDAL #3248][g3248], [#1087][g1087]   | Visible tile borders, one-pixel shifts at zoom 21–22                    | Pre-warp grid differed from the tile grid; window rounding in `geo_query` | Map each output pixel center directly to the source; no intermediate grid |
| Correctness     | [CTB #115][ctb115]                    | Terrain offset from buildings after reprojection                        | Unresolved; reprojected input                                             | Keep sources in EPSG:4326; test against known points                      |
| Correctness     | [GDAL #10510][g10510]                 | `gdalwarp` output shifted                                               | PROJ picked a datum grid outside its area                                 | Avoid datum shifts; pin PROJ and its grids in the image                   |
| Correctness     | [rio-rgbify #38][rgb38], [#35][rgb35] | Artifacts at source edges; blue padding makes harsh hillshade edges     | NoData encoded as values                                                  | Explicit fill policy (sea level), never a sentinel height                 |
| Correctness     | [rio-rgbify #45][rgb45]               | Terrain shifted by 10 km vertically in MapLibre                         | Base and interval of Terrain-RGB mismatched                               | Parameter-free Terrarium                                                  |
| Correctness     | [PMTiles #670][pms670]                | Blurry max-zoom tiles in rio-pmtiles                                    | Shared mutable `OVERVIEW_LEVEL` leaked between tiles                      | Pure per-tile functions; no shared state in workers                       |
| Correctness     | [PMTiles #37][pms37]                  | Root directory out of order (v2 Python writer)                          | Leaf overflow and sparse pyramids                                         | Round-trip tests against an independent reader                            |
| Correctness     | [PMTiles #20][pms20]                  | 64-bit deduplication hash: about 1 in 923 collision odds at 200 M tiles | Hash width                                                                | 128 bits or more, or compare bytes                                        |
| Correctness     | [Planetiler #1633][pt1633]            | Thin ocean seam at z6                                                   | Overlapping pieces simplified separately, then snapped                    | Simplify before cutting, or snap with the neighbor; seam tests on water   |
| Performance     | [GDAL #10803][g10803]                 | 62 hours to tile one VRT at z18                                         | 4× query size; PNG sources fully decoded per read                         | Read from tiled sources (COG blocks); size reads to the output            |
| Performance     | [ctb-docker #1][ctbd1]                | Mesh output reported 700 MB against 40 MB of heightmap                  | Not reproduced (34 MB each)                                               | Report sizes per format in the build estimate                             |
| Performance     | [tippecanoe #392][tip392]             | Per-tile mode cannot keep size limits or consistent dropping            | Whole-level retries only in batch mode                                    | Per-level passes for vector size control                                  |
| Reproducibility | [Planetiler #215][pt215]              | Order of points with equal sort keys not deterministic                  | Missing tiebreaker                                                        | Total orders everywhere (key, then geometry, then tags)                   |
| Reproducibility | [rio-rgbify #43][rgb43]               | Published wheel did not match the source                                | Release process                                                           | Pin by digest or checksum, not by version name                            |
| Reproducibility | [ctb-docker #11][ctbd11]              | Asked how to resume a 70 GB build after a power cut                     | Resume was a separate `ctb-tile -R` flag                                  | Resumable by default with checkpoints                                     |

## 5. How they test

- **Martini and Delatin:** pin exact vertex and triangle arrays, or counts and RMSD, for one real Terrain-RGB fixture ([`martini/test`][mar-test], [`delatin/test`][del-test]). These are golden-output tests.
- **go-pmtiles:** round-trips the directory, header and metadata, checks deduplication and run-length encoding in the resolver, and checks that root directories fit the size limit (`TestOptimizeDirectories`). Planetiler has `PmtilesTest` for the same.
- **tippecanoe:** about 70 golden fixtures, decoded and compared with `cmp`. `parallel-test` builds the same input serially and in parallel and requires identical output. This is the only determinism test among the studied tools.
- **rio-rgbify:** an encode–decode round-trip plus CLI tests against expected MBTiles.
- **CTB:** has no test harness. Its README lists one as a TODO.
- **No studied tool tests:** edges matching between neighboring tiles, poles and the antimeridian, or identical bytes across machines.

## 6. Comparison of approaches

| Question       | Options seen                                                                                                                         | Trade-off                                                                                                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Terrain format | Quantized-mesh (CTB), Terrain-RGB (rio-rgbify), Terrarium                                                                            | Meshes need neighbor-aware LOD (CTB #86) and were not adopted by ADR 0006 (height grids). Terrarium is parameter-free     |
| Edge samples   | 2^k + 1 corner grid (CTB 65², Martini 257²); 256 pixel centers plus client backfill (Martini test, MapLibre); one-pixel border (258) | Corner grids share edges but are not the standard 256 Terrarium. Pixel centers are standard but edges come from neighbors |
| Reprojection   | GDAL warped VRT per tile (CTB, gdal2tiles, rio-rgbify)                                                                               | Correct and general, but window rounding and pre-warp grids caused shifts (GDAL #3248, #1087)                             |
| Lower zooms    | From encoded child tiles (gdal2tiles); a new warp per tile from overviews (CTB, rio-rgbify)                                          | Re-encoding loses quality; per-tile warps cost time and alias without prefiltering                                        |
| Deduplication  | FNV-128a (go-pmtiles), FNV-64 on likely duplicates (Planetiler), MBTiles hash (tippecanoe)                                           | Small collision risk without a byte comparison                                                                            |
| Determinism    | Ordered writers (Planetiler, go-pmtiles); unordered (rio-rgbify); command line in metadata (tippecanoe)                              | Only tippecanoe tests it                                                                                                  |

## 7. Approach chosen and why

ADR 0023 records the decision. The survey supports the following.

1. **Built-in reader instead of GDAL for the default datasets.** All default sources are EPSG:4326 GeoTIFFs:
   - Copernicus GLO-30: float32, DEFLATE, floating-point predictor, 1024² tiles;
   - Sentinel-2 cloudless 2016: 8-bit RGB, LZW, 512²;
   - Natural Earth.

   A TIFF reader for none, LZW and DEFLATE with predictors 1–3 (DEFLATE through `node:zlib`) covers them with no runtime dependency. Every studied failure in the reprojection table (GDAL #3248, #1087, #10510, CTB #115) came from an intermediate grid or a datum transformation. Mapping each output pixel center straight to source coordinates avoids both: Web Mercator to longitude and latitude is closed-form, and there is no datum change. GDAL stays available only through the Docker image pinned by digest, for formats outside the reader such as JPEG2000. That also pins the `gdal raster tile` / `gdal2tiles` behavior change and the PROJ grids.

2. **Terrain: Terrarium PNG, 256 × 256, heights sampled at pixel centers of one global Web Mercator pixel grid.**
   - Global pixel (X, Y) at zoom z is sampled at `((X + 0.5) / (256 · 2^z), (Y + 0.5) / (256 · 2^z))`, so every tile at a zoom is a window of the same lattice.
   - Neighbors therefore never disagree about a pixel, which addresses CTB #71 and GDAL #3248. Children nest exactly in parents: one parent pixel is the area of 2 × 2 child pixels.
   - This is the convention MapLibre and other Terrarium consumers assume, so the tiles stay interoperable.
   - Pixel-center sampling cannot give neighbors a **shared** edge sample. That needs a 2^k + 1 corner grid (CTB, Martini), which is a non-standard Terrarium size, or a one-pixel border. ADR 0006 decodes "within its own pixels" and covers same-level steps with skirts. ADR 0023 should confirm that, or add an opt-in bordered variant (open question 1).
   - Quantization: `v = round((h + 32768) · 256)` with an explicit rounding rule (half up, not NumPy's half-to-even), in signed range (CTB #5). NoData and the voids that remain are filled with 0 m rather than a sentinel (rio-rgbify #35, #38).
   - Lower zooms are 2 × 2 box averages of the float32 child grids, never of encoded tiles (unlike gdal2tiles).
   - Quantized-mesh and Martini or Delatin meshing are not generated. Their seam problems (CTB #86, Martini #7) are exactly what a height-grid engine avoids.
3. **Imagery:** 8-bit RGB is resampled bilinearly at pixel centers at the zoom closest to the source resolution, then reduced by box averaging on raw pixels. Output is PNG for the fallback and JPEG for Sentinel-2. Encoding happens once per tile, so the JPEG loss of gdal2tiles' overview path does not compound.
4. **Vector:** OSM PBF is decoded in TypeScript and encoded as MVT with extent 4096. Features are clipped to the tile plus a buffer (tippecanoe's default is 5/256), and polygons are repaired after rounding (Planetiler). Every sort has a total order (Planetiler #215).
5. **Packages:**
   - PMTiles v3 writer: tiles in TileID (Hilbert) order with `clustered = true`; deduplication by SHA-256 with a byte-length check, wider than PMTiles #20 recommends; run-length encoding; root fitting by iterative leaf sizing as in go-pmtiles.
   - MBTiles through `node:sqlite`, inserted in TileID order.
   - Static z/x/y folders.
   - Metadata JSON with license and attribution (F337). It never contains the command line or absolute paths, unlike tippecanoe's `generator_options`.
6. **Reproducibility:**
   - Versioned JSON configs pin source URLs, versions and SHA-256 checksums, and the image digest. The CTB Docker image's unpinned branch and base are the counterexample.
   - Tiles are processed by pure functions with no state shared between workers (PMTiles #670).
   - Outputs are written in a fixed order (rio-rgbify writes in completion order) and contain no timestamps.
   - Gzip and PNG bytes depend on the zlib build, so byte identity is promised for a pinned Node version. Tests compare decoded content otherwise.
   - Resumable steps with SHA-256 checkpoints (ctb-docker #11, F335).
7. **Tests:** golden tiles for each encoder (as in Martini, tippecanoe), edge equality between neighboring tiles at random locations including poles and the antimeridian, PMTiles round-trips through an independent reader, and tippecanoe-style serial-versus-parallel byte identity.

## 8. Open questions

1. **Edge convention for terrain.** Keep standard 256-pixel Terrarium plus skirts (ADR 0006), or add an opt-in 258 × 258 bordered variant that gives the engine shared edges without fetching neighbors? Decide after the M4 crack sweep.
2. **Copernicus georeferencing.** Settled: the files declare pixel-is-point (`GTRasterTypeGeoKey` = 2) and each file's width follows its latitude band, so the reader honors the key and uses each file's own pixel scale (ADR 0023).
3. **JPEG encoder.** Settled: an original baseline encoder in `packages/tools` (ADR 0023).
4. **Gzip header across platforms.** Node's `gzipSync` writes mtime 0 and OS byte 3 on Linux. Check the Windows value. If it differs, write the gzip header and CRC around `deflateRawSync`.
5. **`node:sqlite`.** Settled: available from Node 22.5 with an experimental warning; the MBTiles writer uses only its synchronous API (ADR 0023).

[ctb]: https://github.com/geo-data/cesium-terrain-builder/tree/8dd633c13582956a2bfdd9f447f62bde04682b9a
[ctb-tb]: https://github.com/geo-data/cesium-terrain-builder/blob/8dd633c13582956a2bfdd9f447f62bde04682b9a/src/TerrainTiler.hpp
[ctbq]: https://github.com/ahuarte47/cesium-terrain-builder/tree/74406677d867d4e4a1f157692b803f3bbfdb876f
[ctbq-mt]: https://github.com/ahuarte47/cesium-terrain-builder/blob/74406677d867d4e4a1f157692b803f3bbfdb876f/src/MeshTiler.cpp
[ctbq-mesh]: https://github.com/ahuarte47/cesium-terrain-builder/blob/74406677d867d4e4a1f157692b803f3bbfdb876f/src/MeshTile.cpp
[ctbd]: https://github.com/tum-gis/cesium-terrain-builder-docker/blob/b673ac45ea652fc411b51863616c3e725556022d/Dockerfile
[mar]: https://github.com/mapbox/martini/tree/f9a7a96b583affff6f9196b9f816a7ee980c5751
[mar-js]: https://github.com/mapbox/martini/blob/f9a7a96b583affff6f9196b9f816a7ee980c5751/index.js
[mar-util]: https://github.com/mapbox/martini/blob/f9a7a96b583affff6f9196b9f816a7ee980c5751/test/util.js
[mar-test]: https://github.com/mapbox/martini/blob/f9a7a96b583affff6f9196b9f816a7ee980c5751/test/test.js
[del]: https://github.com/mapbox/delatin/tree/9bb2f3455c0435bb66eafd9000a6f3161d8451a4
[del-js]: https://github.com/mapbox/delatin/blob/9bb2f3455c0435bb66eafd9000a6f3161d8451a4/index.js
[del-test]: https://github.com/mapbox/delatin/blob/9bb2f3455c0435bb66eafd9000a6f3161d8451a4/test/test.js
[gop]: https://github.com/protomaps/go-pmtiles/tree/a3e4951ea6a0477b784c27c1dcbfd9c130878c5a
[gop-conv]: https://github.com/protomaps/go-pmtiles/blob/a3e4951ea6a0477b784c27c1dcbfd9c130878c5a/pmtiles/convert.go
[gop-dir]: https://github.com/protomaps/go-pmtiles/blob/a3e4951ea6a0477b784c27c1dcbfd9c130878c5a/pmtiles/directory.go
[pms]: https://github.com/protomaps/PMTiles/tree/aec8fa1341222fdddb3318e9ffa8e18e19b312f7
[pms-spec]: https://github.com/protomaps/PMTiles/blob/aec8fa1341222fdddb3318e9ffa8e18e19b312f7/spec/v3/spec.md
[g2t]: https://github.com/OSGeo/gdal/blob/940f7198429fc578694b108631dfe5afd77efd2f/swig/python/gdal-utils/osgeo_utils/gdal2tiles.py
[g2t-ov]: https://github.com/OSGeo/gdal/blob/940f7198429fc578694b108631dfe5afd77efd2f/swig/python/gdal-utils/osgeo_utils/gdal2tiles.py#L1466
[g2t-leg]: https://github.com/OSGeo/gdal/blob/940f7198429fc578694b108631dfe5afd77efd2f/swig/python/gdal-utils/osgeo_utils/gdal2tiles.py#L1708
[rgb]: https://github.com/mapbox/rio-rgbify/tree/a05815d14e0c3dcec4f8509c8d0def578c164eea
[rgb-enc]: https://github.com/mapbox/rio-rgbify/blob/a05815d14e0c3dcec4f8509c8d0def578c164eea/rio_rgbify/encoders.py
[rgb-mt]: https://github.com/mapbox/rio-rgbify/blob/a05815d14e0c3dcec4f8509c8d0def578c164eea/rio_rgbify/mbtiler.py
[tip]: https://github.com/felt/tippecanoe/tree/4f2621186acfec33b63ddf636f665623c0fef2dd
[tip-pm]: https://github.com/felt/tippecanoe/blob/4f2621186acfec33b63ddf636f665623c0fef2dd/pmtiles_file.cpp
[tip-mb]: https://github.com/felt/tippecanoe/blob/4f2621186acfec33b63ddf636f665623c0fef2dd/mbtiles.cpp
[pt]: https://github.com/onthegomap/planetiler/tree/d88cf89f88b7feed75f2e5c9c87d6e7793c4e614
[pt-taw]: https://github.com/onthegomap/planetiler/blob/d88cf89f88b7feed75f2e5c9c87d6e7793c4e614/planetiler-core/src/main/java/com/onthegomap/planetiler/archive/TileArchiveWriter.java
[pt-wp]: https://github.com/onthegomap/planetiler/blob/d88cf89f88b7feed75f2e5c9c87d6e7793c4e614/planetiler-core/src/main/java/com/onthegomap/planetiler/pmtiles/WriteablePmtiles.java
[pt-tg]: https://github.com/onthegomap/planetiler/blob/d88cf89f88b7feed75f2e5c9c87d6e7793c4e614/planetiler-core/src/main/java/com/onthegomap/planetiler/render/TiledGeometry.java
[pt-fr]: https://github.com/onthegomap/planetiler/blob/d88cf89f88b7feed75f2e5c9c87d6e7793c4e614/planetiler-core/src/main/java/com/onthegomap/planetiler/render/FeatureRenderer.java
[mar7]: https://github.com/mapbox/martini/issues/7
[mar23]: https://github.com/mapbox/martini/issues/23
[del2]: https://github.com/mapbox/delatin/issues/2
[ctb5]: https://github.com/geo-data/cesium-terrain-builder/issues/5
[ctb71]: https://github.com/geo-data/cesium-terrain-builder/issues/71
[ctb86]: https://github.com/geo-data/cesium-terrain-builder/issues/86
[ctb115]: https://github.com/geo-data/cesium-terrain-builder/issues/115
[ctbd1]: https://github.com/tum-gis/cesium-terrain-builder-docker/issues/1
[ctbd11]: https://github.com/tum-gis/cesium-terrain-builder-docker/issues/11
[g1087]: https://github.com/OSGeo/gdal/issues/1087
[g3248]: https://github.com/OSGeo/gdal/issues/3248
[g10510]: https://github.com/OSGeo/gdal/issues/10510
[g10803]: https://github.com/OSGeo/gdal/issues/10803
[rgb35]: https://github.com/mapbox/rio-rgbify/issues/35
[rgb38]: https://github.com/mapbox/rio-rgbify/issues/38
[rgb43]: https://github.com/mapbox/rio-rgbify/issues/43
[rgb45]: https://github.com/mapbox/rio-rgbify/issues/45
[pms20]: https://github.com/protomaps/PMTiles/issues/20
[pms37]: https://github.com/protomaps/PMTiles/issues/37
[pms670]: https://github.com/protomaps/PMTiles/issues/670
[pt215]: https://github.com/onthegomap/planetiler/issues/215
[pt1633]: https://github.com/onthegomap/planetiler/issues/1633
[tip392]: https://github.com/felt/tippecanoe/issues/392
