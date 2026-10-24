# 0133. Raster, hillshade and heatmap layers as textured tile squares; fill and line extras

- Status: Accepted (decided by agent; owner may revisit)
- Date: 2026-10-24
- Milestone: M13 (F445; track D of `docs/parallel-tracks.md`)

## Context

F445 asks for every layer type of the pinned specification (26.4.4, v8; ADR 0041): besides the vector types of
ADR 0131, `raster`, `hillshade` and `heatmap`, and the line and fill properties `line-dasharray`, `line-cap`,
`line-join`, `line-gradient`, `fill-pattern`, `fill-outline-color` and `fill-opacity`. A render extension draws into the
engine's scene and has no render-to-texture pass of its own.

## Options considered

1. **Raster-like layers.** (a) Screen-space passes (heatmap density accumulated in an offscreen target, hillshade
   computed in a shader from a DEM texture), as MapLibre does; (b) one image per tile made on the CPU and drawn as a
   textured tile square that follows the globe, the morph and the terrain like the background. (a) needs passes the
   extension interface does not offer; (b) reuses the vector tile placement, clipping and stand-ins.
2. **Heatmap edges.** Kernels reach past a tile's square: each tile's image sums the points of the tile and its eight
   neighbors at the same zoom (each tile lays out only the points of its own square), and is made again as they arrive.
3. **Line gradients.** `line-progress` needs the position along the whole line, which a vector tile does not carry; the
   specification allows `line-gradient` only on GeoJSON sources with `lineMetrics`, whose locally cut tiles give each
   piece its share of the whole line (`mapbox_clip_start`, `mapbox_clip_end`). The gradient is evaluated per vertex
   (lines are split every 64 tile units) instead of a ramp texture, so all lines keep one shader program.
4. **Fill patterns.** The sprite image is packed in the label atlas (ADR 0132) and repeated every image size in CSS
   pixels at the tile's own zoom, anchored to the tile, so tiles of a zoom continue it.

## Decision

1 (b), 2, 3 and 4. Raster and raster-dem tiles are requested through the transport and decoded on the main thread
(`createImageBitmap`, then their pixels); hillshade shading (light at 45° from `hillshade-illumination-direction`,
slopes from one-sided differences at the image border) and heatmap densities (Gaussian kernels of
`heatmap-radius` = 3 σ, colored through `heatmap-color` with `['heatmap-density']`) are computed per tile
(`raster-images.ts`). Raster paint (`raster-opacity`, brightness range, saturation, contrast) is applied in the shader.
A fill with `fill-outline-color` gets a second bucket, its rings as a line two pixels wide (one pixel misses pixel
centers along some edges).

## Consequences

- Layers compose in linear light like the rest of the engine: a fill at `fill-opacity` 0.5 over white is lighter than
  MapLibre's sRGB blend; F445's spec checks the linear-light result.
- Raster tiles are drawn at the target zoom whatever their `tileSize` (a 256-pixel tile is magnified twice), hillshade
  images are made at the DEM tile's zoom, and heatmap images every quarter zoom: listed in `docs/hardening-backlog.md`.
- CPU images cost main-thread time when tiles arrive (a 256² hillshade or a 128² heatmap image takes a few
  milliseconds); they count in the vector tile frame budget of ADR 0131.
