# 0034. Vector tiles, buildings and 3D Tiles: computational parts

- Status: Accepted
- Date: 2026-10-22
- Milestone: M13

## Context

M13 draws MapLibre-styled vector tiles, OpenStreetMap roads, places and building extrusions, and streams OGC 3D Tiles
(F439–F472). `PLAN.md` asks for no seams, no label flicker, no popping, no holes, work off the main thread and memory
within budgets; CLAUDE.md asks for maintained, permissively licensed libraries over own code where one fits. The
survey [`docs/research/vector-and-3d-tiles.md`](../research/vector-and-3d-tiles.md) studied MapLibre GL JS and
Native, Tangram, OpenLayers, deck.gl, CesiumJS, 3DTilesRendererJS, iTowns and loaders.gl. This ADR covers the parts
that need no renderer internals, built by the eighth parallel session (`docs/parallel-tracks.md`); drawing stays with
the main track.

## Options considered

1. **Style evaluation:** (a) `@maplibre/maplibre-gl-style-spec` (ISC, maintained, what MapLibre GL JS itself uses);
   (b) our own expression engine. (a) gives the specification's exact semantics, legacy filter conversion and
   validation with JSON paths for free.
2. **Tessellation:** polygons with `earcut` (ISC) versus our own triangulator; lines with our own stroke builder
   (no maintained, renderer-free line tessellator exists that keeps width out of the geometry).
3. **Text:** our own small shaper over glyph-server metrics versus a full shaping engine (HarfBuzz in WebAssembly,
   about 1 MB); the latter is needed only for complex scripts.
4. **3D Tiles:** (a) loaders.gl's `Tiles3DLoader` and `Tileset3D`; (b) 3DTilesRendererJS's core, as iTowns now
   does; (c) our own parser and traversal. (a) and (b) bring their own request queues and caches, which would bypass
   the engine scheduler and memory budgets (F462), and (b) keeps frustum and screen-space-error code in its three.js
   classes and declares three.js, Babylon.js and React peer dependencies.

## Decision

1. Styles: `@maplibre/maplibre-gl-style-spec` pinned at **26.4.4** (style specification v8, as of that release).
   `VectorStyle` validates on load with `validateStyleMin`; a property that fails falls back to its default, a layer
   that fails (missing source, wrong type, bad filter) is left out, and loading never throws. Runtime changes report
   their cost: `paint` re-evaluates on the next frame, `layout`, `filter` and order rebuild buckets from the kept
   decoded features; nothing is downloaded again. Layers cross-fade over 300 ms at their zoom limits and on
   visibility changes.
2. Tessellation in workers: fills with earcut after Sutherland–Hodgman clipping to the tile extent plus a buffer;
   lines with our own builder whose vertices carry a center-line point, an extrusion vector in half-widths and the
   distance along the line, so `line-width` is a paint value (continuous at fractional zoom, F440, F450). No cap at
   ends clipped at the tile buffer, no extrusion wall on the tile edge.
3. Text: our own shaper (24 px em, greedy line breaking at spaces and ideographic opportunities, anchors, justify,
   letter spacing), glyph ranges requested only for the code points in use, font-stack fallback that leaves out
   characters no stack has. Right-to-left and complex scripts: `docs/follow-ups.md`.
4. Labels: anchors every `symbol-spacing` inside the tile's own extent only (a road crossing a tile edge is labelled
   by one tile), refused where the line bends more than `text-max-angle` under the label; collision in rbush with
   priorities (top style layer, then `symbol-sort-key`); a cross-tile index that gives a label one id across parent
   and child tiles; fades on the engine clock.
5. Buildings: height from `height` / `render_height`, else `building:levels` × 3 m, else a documented default by
   type (`docs/guides/data-layers.md`); base from `min_height` / `render_min_height` or `building:min_level` × 3 m;
   building parts hide the outline that contains them (and `hide_3d`). Flat-map heights scale by `1 / cos(latitude)`.
6. 3D Tiles: our own parser (tileset JSON 1.0 and 1.1, b3dm, i3dm, pnts and cmpt headers with feature and batch
   tables, glTF handed to the glTF loader, implicit tiling with subtree availability, metadata schema) and traversal
   (screen-space error from geometric error, REPLACE keeps the parent until every child is ready, ADD draws both,
   priorities by error and distance to the screen center, cancellation, LRU eviction within a byte budget that may
   overflow while the visible set needs it, as Cesium does). Lives in `packages/sources/src/tiles3d/`.

## Consequences

- The renderer implements drawing of these buckets (hook requests in `docs/parallel-tracks.md`); until then the
  visual and performance steps of M13 stay failing with that blocker named.
- The style engine is a dependency of `@vibeglobe/layers` already (ADR 0029); earcut and pbf are added.
- Verified by unit and property tests next to the code (`packages/layers/src/vector-tiles/*.test.ts`,
  `packages/sources/src/tiles3d/*.test.ts`), including style fuzzing and 3D Tiles content fuzzing.
