# 0045. Distance-field labels of data layers

- Status: Accepted
- Date: 2026-10-24
- Milestone: M10 (F358)

## Context

Data-layer labels (ADR 0037) were drawn as bitmaps: each text rasterized on a 2D canvas at its size and the screen's pixel ratio, in its colors and halo, into a shared RGBA atlas. F358 asks for signed distance field glyphs, crisp at any size, zoom and pixel density, generated off the main thread and cached in an atlas. Track D's vector-tile labels (ADR 0132) already draw glyph-PBF distance fields one quad per glyph, shaped on the CPU.

## Options considered

1. **One distance field per label text.** The browser rasterizes the whole text once at a reference size, with its own fonts and shaping (every script the page shows, ligatures, right-to-left), a worker turns the coverage into a distance field, and the label stays one quad. Fields serve every size, color, halo and pixel ratio.
2. **One field per glyph, laid out on the CPU** (track D's path). Smaller atlas for repeated characters, but shaping is ours: no ligatures, no complex scripts without a shaping engine, one quad per glyph.
3. **Keep bitmaps at each size and ratio.** Not distance fields; blurs when scaled.

## Decision

Option 1. `LabelSdf` (renderer) rasterizes a text at 12 px for labels under 14 px and at 16 px above (thin strokes scaled down from a larger field shimmer as they move, F360; a 12 px field loses a CJK glyph's end strokes at 18 px, F357), with a 6-texel buffer, posts the coverage to a module worker (`label-sdf-worker.ts`, `sdfFromCoverage` of ADR 0132) and adds the replies to a one-channel 4096 × 4096 `SdfAtlas`, 50 ms of replies at a time (neither backend uploads part of a texture). A label waits, collapsed, until its field is in the atlas; then only the features that waited are rewritten (`FieldWaits`), and the core hook `LayerRenderTarget.onContentReady` asks for a frame. Where no worker starts the field is generated on the calling thread. The layer shader draws fill and halo from the field, anti-aliased over about one device pixel from the field's scale and the pixel ratio (a screen-space derivative of the 8-bit field moved text in pixel steps, F360); the label's color is its vertex color, the halo's sRGB bytes ride in two 16-bit values of the spare uv channels. Halos reach at most 5 texels at the reference size (beyond, the field is 0 and the halo would fill the quad). Collision boxes keep the text's advance and line height with 3 px around (F359).

## Consequences

- Text sizes from 8 to 64 px at pixel ratios 1–3 measure an edge sharpness of 0.60–0.98 against the documented 0.5 (`e2e/data-labels-sdf.spec.ts`).
- A label shows a few frames after its first placement, once its field arrives; the placer's fade starts at placement, so the first frames of a fade-in can be empty.
- The atlas holds about 8,000 short labels (16 MB, as the RGBA bitmap atlas it replaces); when full it starts over and every label batch is rebuilt, like the marker atlas.
- The marker atlas (`LayerAtlas`) now holds images only.
