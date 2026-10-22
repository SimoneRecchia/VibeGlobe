# 0026. Detailed imagery from the ESA WorldCover 2021 Sentinel-2 composite

- Status: Accepted
- Date: 2026-10-22
- Milestone: M9

## Context

`PLAN.md` named Sentinel-2 cloudless 2016 by EOX as the detailed imagery source. ADR 0025 found that the requester-pays bucket of the 2016 originals no longer exists, so no default build could download it (`docs/open-questions.md`, question 22). The owner decided on 2026-10-22 to use the ESA WorldCover Sentinel-2 RGBNIR yearly median composite instead: 2021, 10 m, CC BY 4.0, in the public bucket `esa-worldcover-s2` (no AWS account, not requester-pays). Bands B04, B03 and B02 map to RGB with a fixed, documented colour stretch.

The files were read from the bucket on 2026-10-22:

- One cloud-optimized GeoTIFF per 1° × 1° cell, named by its south-west corner (`rgbnir/2021/N45/ESA_WorldCover_10m_2021_v200_N45E006_S2RGBNIR.tif`). There is no file for a cell without land (HTTP 404).
- Each file is about 570 MB: classic little-endian TIFF, 12,000 × 12,000 pixels, four uint16 bands in the order B04, B03, B02, B08. Reflectance is stored × 10,000, compressed with DEFLATE and predictor 2 in 1024-pixel tiles, with overviews at 1/2, 1/4, 1/8 and 1/16. No data is 0.
- The composite has no data (all bands 0) where Sentinel-2 never saw clear ground in 2021. Over the Mont Blanc sample this is mostly glaciers, up to 23% of a 1024-pixel tile. The sea is 0 too, and internal tiles over open sea are left out of the file.
- In the WorldCover 2021 land-cover map (`esa-worldcover/v200/2021/map/…_Map.tif`, 3° × 3° cells, same 10 m grid, same licence), these gap pixels are 85% class 70 (snow and ice) and 14% class 60 (bare or sparse vegetation).

## Options considered

1. **Download whole cells:** simple, but a sample build of one zoom-10 tile would transfer four files, about 2.3 GB.
2. **Read only the needed internal tiles with HTTP range requests (chosen):** the header of each COG (every IFD) fits in the first megabyte. The pipeline reads it, then fetches only the internal tiles of one overview level that intersect the area. It writes them, still compressed, into a small local GeoTIFF that the built-in reader opens like any other file. The Mont Blanc sample transfers 74 MB instead of 2.3 GB.
3. **For the gaps: a constant colour.** One colour cannot suit both glaciers and the sea. A dark sea colour paints blue blobs over the glaciers; a white one paints white rectangles on the sea.
4. **For the gaps: fill by land-cover class from the WorldCover map of the same year (chosen):** the map is from the same project and licence, so the attribution does not change. Its windows add about 2% to the download. Gaps take a fixed reflectance per class; gaps on water, unlisted classes or outside the map keep the sea colour.

## Decision

- A `worldcover-s2` source type reads windows of overview level `overview`: 0 (10 m) for `italy-high`, z9–14; 4 (about 160 m) for `world-low`, z0–8. A missing cell is "no data".
- **Colour stretch** (`colorStretch` in the configuration), the same for the three bands:
  `rgb = round(255 × min(1, reflectance / 3000) ^ (1 / 2))`.
  A 0.30 reflectance is white, and the gamma of 2 lifts the dark vegetation (about 0.05) to 104 of 255. The values were chosen on the Mont Blanc sample (glaciers, rock, forest, villages) and checked on the Gulf of Naples (sea, coast, city, Vesuvius).
- **Sea and no data:** reflectance `[135, 245, 372]`, the median of the composite's own sea pixels around Naples (land-cover class 80 or outside the map). After the stretch, `[54, 73, 90]`.
- **Gaps on land** take the mean reflectance of each class's valid pixels on the Mont Blanc sample:

| Class               | Reflectance (B04, B03, B02) |
| ------------------- | --------------------------- |
| 10 tree cover       | 447, 561, 408               |
| 20 shrubland        | 480, 710, 405               |
| 30 grassland        | 1034, 1134, 904             |
| 40 cropland         | 635, 751, 429               |
| 50 built-up         | 1069, 1033, 879             |
| 60 bare or sparse   | 2614, 2640, 2565            |
| 70 snow and ice     | 3870, 4178, 4485            |
| 100 moss and lichen | 1771, 1786, 1604            |

- The attribution, profile `esa-worldcover-s2-2021`, is the project's own text for a map layer: `© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium`. It is recorded in ADR 0025 and `docs/data-licenses.md`.
- The Sentinel-2 cloudless code stays (F340 and the fixture stub) for anyone who has the 2016 originals; the shipped configurations no longer use it.

## Consequences

- The default imagery is from 2021 instead of 2016, at the same 10 m.
- Filled gaps are flat colours: on glaciers they look like snow, on rock like light-grey scree. Open sea is a flat colour where the source left tiles out, matching the median of the real sea next to it but not its texture.
- The estimate counts the window share of each file (area and overview level), plus the map windows. It reads a little high: a sea-heavy window compresses better than the average file.
- A source with its own gaps or another band scale needs its own stretch and gap rules, recorded the same way.
