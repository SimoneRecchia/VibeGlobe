# 0131. Vector tile rendering: a render extension over renderer-neutral buckets

- Status: Accepted (decided by agent; owner may revisit)
- Date: 2026-10-23
- Milestone: M13 (F440–F459, track D of `docs/parallel-tracks.md`)

## Context

ADR 0041 built the computational parts of vector tiles in `packages/layers/src/vector-tiles/` (style evaluation and
validation, tessellation, shaping, placement, buildings, tile pyramid) and left drawing to the renderer. Track D draws
them through the engine's extension points: `Globe.addRenderExtension` (the three.js scene and depth path, the page's
request pool and the worker pool) and the `layout-vector-tile` worker task. `PLAN.md` asks for no seams, no holes, no
popping, work off the main thread, the same look in the globe, 2D and 3D phases, and both backends.

## Options considered

1. **Where the frame logic lives.** (a) In `@vibeglobe/renderer`, importing `@vibeglobe/layers`; (b) in
   `@vibeglobe/layers/vector-tiles` behind a renderer-neutral target interface, as data layers draw through
   `LayerRenderTarget` (ADR 0029), with the three.js target in `@vibeglobe/renderer/vector-tiles`. (b) keeps three.js
   out of `layers`, keeps the renderer free of style code, and lets Node tests record what is drawn.
2. **Placing vertices.** (a) Upload tile units and project in the shader; (b) the worker writes, per vertex, the same
   attributes a surface tile vertex has (offset from the tile's origin, ellipsoid normal, Web Mercator plane offset),
   so the renderer's existing morph and precision path (ADR 0004, ADR 0008, ADR 0037) places them. (b) reuses tested
   code and gives the globe, 2D and 3D phases one path. Long edges at low zoom are split first (fills clipped to a grid
   of cells, lines densified) so chords follow the curvature: 90 · 2^(−z/2) pieces per tile side, none from zoom 13.
3. **Which tiles.** (a) The surface's tiles (zoom L − 1 for a level-L surface tile): exact coverage, but without
   imagery the surface never refines, so they say nothing about detail; (b) screen samples: at a 13 × 10 grid, the
   zoom at which a 512-pixel tile matches the local ground scale. Chosen: both. The union is turned into a partition:
   a tile with a deeper tile inside it is split into its children, recursively, so every point is drawn by one target.
4. **Seams and stand-ins.** A tile's buffer overlaps its neighbors, and a stand-in ancestor covers more than its
   target. Every draw carries its target square in the drawn tile's units and fragments outside it are discarded (lines
   by their center-line position, so the two tiles of an edge cut them at the same place). A tile at a zoom beyond the
   source's `maxzoom`, or not loaded yet, is drawn by its nearest ready ancestor clipped to its square (`tilesToDraw`).
5. **Paint.** (a) Evaluate per frame on the CPU; (b) per vertex at the two integer zooms around the camera's, mixed in
   the shader by the fractional part, re-evaluated in place when the integer zoom, the style's paint or feature-state
   change. (b) gives continuous widths and colors at fractional zoom (F440) at the cost of two values per property.
6. **Lines.** The tessellator's extrusion vectors are in tile units; the shader projects the center-line point and a
   point a few tile units along the extrusion, and offsets the vertex by half the width in CSS pixels along the screen
   direction between them. Widths are therefore screen-exact on the globe and the plane alike. Dashes use the distance
   along the line in tile units times CSS pixels per tile unit (`line-dasharray` in line widths, up to two pairs).
7. **Buildings.** Heights above the ground are not scaled by the relief factor (it flattens terrain in 2D, not
   buildings) and on the plane they scale by k(φ) = 1 / cos φ (F458). Walls are flat-shaded from the specification's
   default map-anchored light, with a vertical gradient.

## Decision

Options 1(b), 2(b), 3 (both), 4, 5(b), 6 and 7. `addVectorTiles(globe, { style, target })` of
`@vibeglobe/layers/vector-tiles` loads the style (URL or JSON), resolves TileJSON sources, and adds one render
extension; `createVectorTileTarget` of `@vibeglobe/renderer/vector-tiles` is the three.js target. Tiles are requested
through the page's request pool (per-host limits, coalescing, cancellation of tiles no frame wants), laid out by
`layout-vector-tile` on the engine's workers with their globe attributes (`LayoutInput.tile`), and kept with their
bytes so a layout or filter change lays them out again without downloading (F450). A response that is an HTML page
(a static host's single-page fallback) counts as a missing tile, like a 404. Meshes interleave their attributes into
two vertex buffers (fixed geometry, paint), within WebGPU's limit of eight. Vector layers draw at render order 500 and
up, under data layers (1000 and up) and over the surface. The `background` layer is a subdivided square per target.

## Consequences

- `@vibeglobe/renderer` gains the `./vector-tiles` export (hook request D (2)).
- One material, and so one shader program, per mesh kind (fill, line, extrusion, circle; solid or translucent
  extrusions): a layer's opacity, zoom factor, dash and height scale are per-object uniforms, so a layer appearing
  during navigation compiles nothing (each program build was a 50–200 ms main-thread task on WebGL2, F443).
- Main-thread budget (F443): the vector tile work of a frame (tile choice, draping, paint, mesh creation, label
  placement) stays within 4 ms p95 while moving, inside the engine's 6 ms frame (`docs/plan/quality.md`), with no
  main-thread task over 50 ms; decoding and tessellation run only in the workers. `VectorTileLayer.frameTimeMs()`
  reports it. The engine gives extensions its workers only on a globe with tiled imagery or terrain (hook request
  D (4)); elsewhere layout runs inline.
- Labels are drawn by the same target as screen-space quads (ADR 0132).
- Engine log and `error` events of style problems need a hook (D (1)); until then problems are kept on the style
  (`VectorStyle.problems`) and written to the console.
- Tested by unit tests in `packages/layers/src/vector-tiles/render.test.ts` and end-to-end specs in
  `e2e/vector-tiles/`, over fixtures generated by `e2e/vector-tiles/fixtures/generate.ts` into
  `apps/playground/public/vector-tiles/` (invented geography; glyphs drawn from the OFL-licensed Inter font).
