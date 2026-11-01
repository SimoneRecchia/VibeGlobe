# 0039. Client-side raster reprojection and tone harmonization between chained sources

- Status: Accepted (decided by agent; owner may revisit)
- Date: 2026-10-23
- Milestone: M7 (F226, F227, F228, F249; survey: docs/internal/research/source-adapters.md)

## Context

The engine draws imagery in two tiling schemes only, Web Mercator and geographic (ADR 0010, M3). M7 asks for rasters in
other reference systems, such as Italian data in UTM zones 32N and 33N, to line up with them in every phase (F226), for
services that can deliver a supported system to be asked for it directly (F227), for custom tile matrix sets (F228), and
for a layer whose chained sources have different tones not to show a visible step where it switches source (F249).

Prior art (survey, "Raster reprojection, source fallback and color matching"): CesiumJS draws only its two schemes and
needs a server that offers one; OpenLayers triangulates the target extent and draws each triangle of the source image
with an affine map, with seams where neighbouring tiles triangulate differently or source tiles have gaps. No engine
matches colors between sources automatically; mosaics are balanced offline.

Options for reprojection:

1. **Warp on the client into the engine's own tiles**: for each target tile, one source image covering its footprint
   (a WMS GetMap in the source system, or a mosaic of the source's tiles), drawn through a fixed grid of triangles each
   with its affine map, into a tile the engine then treats like any other.
2. Reproject on the GPU per pixel with the inverse projection in the surface shader: exact, but every reference system
   needs shader code, and the surface material is shared by every draw (ADR 0010).
3. Refuse other systems and require a server or the data pipeline to deliver Web Mercator or geographic tiles.

Options for tone harmonization:

1. **Feather the coverage boundary**: where a chain's detail source ends inside a coarser one, fade it out over a band
   of a few screen-sized texels, so the switch is a gradient, not a step; plus per-source color adjustments
   (brightness, contrast, saturation, gamma) the application sets where the sources differ systematically.
2. Estimate a per-source color transform automatically from the overlap of both sources (histogram matching), at run
   time from decoded tiles.
3. Leave it to the data pipeline (histogram matching offline).

## Decision

Reprojection: option 1 (`reprojectedImagery` in `@vibeglobe/sources`).

- A target tile's footprint is sampled in the source system and widened by a margin; one source image is asked for it
  at about the tile's resolution (capped at twice the tile size), cut to the source's bounds.
- A 16 × 16 grid of triangle pairs, each drawn with its own affine map and clipped to its triangle widened by a fraction
  of a pixel, so neighbours overlap instead of leaving antialiased cracks; the error of a cell's affine map is far below
  half a pixel at tile sizes (unit tests against proj4js with property-based round trips).
- Pixels outside the data stay transparent, and the source is declared transparent so it composes over the layers
  below (ADR 0038). Transparent and antialiased edge pixels take their opaque neighbours' color before upload, because
  textures are filtered with straight alpha and a canvas stores black under zero alpha (the dark seam along a zone's
  edge, F226).
- Adapters that can ask for a supported system do so first (WMS CRS, WMTS matrix set; `preferredCrs`), and reproject
  only otherwise (F227).

Tone harmonization: option 1. Automatic matching (option 2) needs both sources' tiles of the same area at once and
re-estimates as tiles arrive, which itself causes visible shifts; offline matching (option 3) remains the recommendation
for mosaics the application controls.

## Consequences

- Any reference system proj4js knows can be shown, through a function pair the application supplies (`toSource`,
  `fromSource`), with the engine's tiles, caches, fades and picking unchanged.
- One request per target tile instead of reusing the source's own tiles: more requests when the source has a tile grid
  of its own (F228 mosaics several source tiles per target tile).
- A feathered boundary shows both sources mixed over a narrow band; it can be turned off per layer.
