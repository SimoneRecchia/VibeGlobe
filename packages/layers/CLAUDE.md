# @vibeglobe/layers

Application data layers: primitives, labels, styling expressions, clustering, picking, draping and ground clamping.

## Rules

- Single-feature updates patch GPU buffers in place; never rebuild a layer for one feature.
- Layers draw only through `LayerRenderTarget` (`src/render-target.ts`); tests use `RecordingRenderTarget` (`src/testing.ts`, `@vibeglobe/layers/testing`), which records every upload. three.js never appears here (ADR 0029).
- Styles are MapLibre Style Specification properties and expressions, compiled by `@maplibre/maplibre-gl-style-spec`; a missing property makes the style engine fall back to the default with a warning, which is slow, so test fixtures carry every property their style reads.
- Never key something costly by a version that changes all the time: raster-like meshes (hillshade, color-relief, raster, heatmap) once took the terrain's version and the zoom in their cache keys, so every terrain tile remade every hillshade image on the CPU (KB-242). They keep their key and take the new ground in place, as vector meshes do.
- Vector meshes are built and repainted within a frame budget (`tile-mesh-cache.ts`, KB-244): `get` returns `DEFERRED` past it, and the layer draws `standIns` (a kept mesh around or inside the tile, clipped to its square) meanwhile; a mesh still painted for another zoom pair is drawn with its own `zoomT`. Never build or repaint every mesh in one frame: a level crossed with region borders took 340 ms.
- Paint versions are per layer (`PaintStamps`): a `setPaintProperty` repaints only its layer, visibility and zoom ranges repaint nothing, a feature state repaints all. A symbol layer has no meshes: its paint is evaluated per label per frame, so changing it is free.
- Owned by the data-layers parallel track (`docs/parallel-tracks.md`): drawing, draping, clamping, terrain picking and glTF are the main session's.

## Commands

- `npm test` (root) runs this package's tests; tests sit next to the code as `*.test.ts`.
- `npm run build` (root) builds it with `tsc -b` to `dist/` (ESM + declarations).

See the root `CLAUDE.md` for the workflow and `docs/plan/architecture.md` for where this package fits.
