# 0132. Vector tile labels: CPU placement, one SDF atlas, a screen-space text material

- Status: Accepted (decided by agent; owner may revisit)
- Date: 2026-10-24
- Milestone: M13 (F448, F449, F454; F358 reuses the atlas and material; track D of `docs/internal/parallel-tracks.md`)

## Context

ADR 0041 left label shaping, anchors and collision in `packages/layers/src/vector-tiles/` without drawing them.
Labels must stay upright and readable in every phase and tilt, never overlap, never duplicate across tile edges, fade
instead of popping (F449, F454), stay crisp at every size and pixel density (F448), and the main session's data-layer
labels (F358) want the same text rendering.

## Options considered

1. **Placement.** (a) In the worker per tile, at layout zoom, then drawn in tile space; (b) anchors per tile in the
   worker, placement on the main thread every frame in screen space. (a) cannot collide across tiles or follow tilt
   and morph; (b) costs CPU per frame but sees the final screen. Chosen: (b), with a `CrossTileSymbolIndex` so a label
   on two tiles keeps one identity and its fade.
2. **Glyphs.** (a) Canvas text per label; (b) signed-distance-field glyphs from the style's `glyphs` URL (PBF ranges
   of 256 code points), as the MapLibre specification expects, in one RGBA atlas packed in shelves. (b) scales one
   glyph to any size and draws halos from the same field. Ranges are requested only for the code points the visible
   labels use; code points the style's glyphs lack are drawn locally (`localFontFamily`, Felzenszwalb's distance
   transform of a canvas rasterization) instead of leaving boxes.
3. **Drawing.** (a) A mesh per label; (b) one dynamic buffer of quads whose corners are CSS pixels, rewritten each
   frame, with one material (`createTextMaterial`) that maps pixels to clip space, shades fill and halo from the SDF,
   and draws last without depth test (placement already removed labels behind the globe or terrain).

## Decision

1 (b), 2 (b) and 3 (b). The atlas (`SdfAtlas`) and the text material (`createTextMaterial`, `setTextViewport`) are
exported from `@vibeglobe/renderer/vector-tiles` for data-layer labels (F358). Sprites load at the device pixel ratio
(`@2x` at ratio 2 and above) into the same atlas.

## Consequences

- One draw call for every label of a frame, after the vector layers (the engine renders in scene order).
- Placement time grows with the visible labels; it counts in the vector tile frame budget of ADR 0131.
- Labels hidden by terrain are tested against `elevationAt`, not the depth buffer.
