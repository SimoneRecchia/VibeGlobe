# 0024. Data pipeline: a TypeScript pipeline with built-in readers, external tools only in pinned Docker images

- Status: Accepted
- Date: 2026-10-21
- Milestone: M9

## Context

`PLAN.md` asks for command-line tools that download, convert and tile each default dataset (Copernicus DEM GLO-30, Sentinel-2 cloudless 2016, a global fallback raster, OpenStreetMap extracts), with region-based builds, offline packages and static folders, license records, reproducibility from versioned configuration, resumable steps and size estimates. The tools "may call GDAL or other tools, for example through Docker". F331 requires every external tool to run in a Docker image pinned by digest, with nothing on the host beyond Node and Docker. ADR 0015 (decision 4) restricts the project's own runs to small sample areas.

The survey ([data-pipeline.md](../research/data-pipeline.md)) shows that every default raster source is a GeoTIFF in EPSG:4326 with a small set of encodings. Copernicus DEM COGs are float32 with DEFLATE and the floating-point predictor, pixel-is-point, with 1024-pixel internal tiles and widths that shrink by latitude. Sentinel-2 cloudless originals are 8-bit RGB with LZW, and Natural Earth rasters are uncompressed TIFFs inside zip archives. GDAL-based tile cutters disagree on pixel conventions and edge handling ([gdal#1087](https://github.com/OSGeo/gdal/issues/1087), [rio-rgbify#35](https://github.com/mapbox/rio-rgbify/issues/35)). PMTiles writers need content-hash deduplication with wide hashes ([PMTiles#20](https://github.com/protomaps/PMTiles/issues/20)).

## Options considered

1. **GDAL for everything (gdalwarp, gdal2tiles, Docker):** proven readers and warping. But every step needs Docker, tests need the image, gdal2tiles' output depends on its version and options, and terrain encoding, MVT and PMTiles still need other tools.
2. **Planetiler or tippecanoe for OSM, GDAL for rasters:** two large external toolchains to pin, so neither sample builds nor unit tests run without Docker.
3. **A TypeScript pipeline with built-in readers and encoders; external tools only in Docker images pinned by digest, for inputs the built-in readers do not handle:** the default datasets need nothing but Node, tests run everywhere, and every byte of output comes from code the project controls. The cost is writing a TIFF reader, PNG and JPEG encoders, an MVT encoder, an OSM PBF reader and PMTiles and MBTiles writers.

## Decision

Option 3.

- **Readers:** a built-in GeoTIFF reader (classic TIFF, tiled or stripped, none/LZW/DEFLATE, predictors 1–3, uint8/uint16/int16/float32) that honors `GTRasterTypeGeoKey`; a zip reader for Natural Earth; an OSM PBF reader. An input outside this set (JPEG2000 raw Sentinel-2, other projections) is converted by GDAL in the image named by the configuration's `tools.gdal`, which must be pinned by digest (`name@sha256:…`; the validator refuses tags). Docker runs with `--network none`, and only the build folder is mounted.
- **Tiling:** Web Mercator XYZ tiles of 256 px on one global pixel grid. The maximum zoom of a dataset is sampled from the sources at pixel centers, with bilinear interpolation and box supersampling when a pixel covers several source pixels. Lower zooms are 2×2 means of their children, so every level comes from the same samples.
- **Terrain encoding:** Terrarium PNG (`(R·256 + G + B/256) − 32768` m, a step of 1/256 m). Each tile holds only its own pixels; the engine hides cracks with skirts (ADR 0006). A bordered 258-px variant stays a follow-up until M4's crack sweep shows a need for it (since 2026-10-25 it is the format, see the update below).
- **Imagery:** PNG for the fallback pyramid; baseline JPEG (an original encoder written from ITU-T T.81, 4:4:4) for Sentinel-2. **Vectors:** MVT with a 64-unit buffer, clipped per tile.
- **Outputs:** static `z/x/y` folders, PMTiles v3 (original writer: tiles in Hilbert order, deduplicated by SHA-256, gzip-compressed directories with a zero mtime) and MBTiles (`node:sqlite`). Each output carries a `metadata.json` with license and attribution (ADR 0025).
- **Reproducibility and resumption:** configurations pin source versions and image digests. Encoders are deterministic, and outputs contain no timestamps. Each step writes files atomically (a temporary file, then a rename) and appends the file's SHA-256 to a step log. A rerun skips an item only when its file still matches the logged checksum, so corrupted downloads and tiles are regenerated.
- **Estimates and cost:** tile counts are exact per zoom level. Bytes come from each dataset's measured average tile size, and cost from the per-GB prices and reading date recorded in the configuration. Nothing is downloaded before the estimate is shown and confirmed (`--yes` in non-interactive runs).

## Consequences

- Sample builds and every pipeline test need only Node 22.18+. Docker is needed only for inputs that need GDAL, and the runner refuses to start an unpinned image.
- The project owns more code: the readers and encoders have unit tests against known values and real file headers.
- `node:sqlite` prints an experimental warning on Node 22. The MBTiles writer uses only its stable synchronous API.
- Verification: the unit tests (configuration validation, tile math, estimate, license gate, readers and encoders, PMTiles round trip) and the sample builds in `packages/tools/configs/`.

## Update 2026-10-25: bordered terrain tiles (KB-178)

The real Mont Blanc data showed the need §"Terrain encoding" left open: neighbors extrapolating their outer half pixels on their own disagreed by up to 275 m on Alpine relief. Terrain tiles are now 258 × 258 px Terrarium PNG: the tile's own 256 × 256 pixels and a ring of one pixel from each of its eight neighbors (from their intermediate tiles, or sampled from the sources for neighbors outside the area; columns wrap at the antimeridian, rows repeat at the tiling's edges). The engine reads any heightmap of a power of two (16 or more) plus 2 pixels as bordered (ADR 0006, update of 2026-10-25). A tile is re-encoded when its own or a neighbor's intermediate samples change; its log entries have a new step name, so builds made before are re-encoded on their next run.
