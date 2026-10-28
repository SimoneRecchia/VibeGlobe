# 0044. Tone matching of source chains

- Status: Accepted
- Date: 2026-10-24
- Milestone: M7 (F249)

## Context

A layer's chain of sources (ADR 0038) can mix sources of different brightness and color balance: a global package and a regional online source, for one. Where the active source changes, at a level or at a coverage edge, the change of tone shows as a step. F249 asks that neither the switch nor the boundary is visible, and that a layer can turn the adjustment off.

## Options considered

1. **Per-channel gains from the means in view.** Each tile's mean color is measured once at upload (a 4 × 4 downscale on a 2D canvas); each frame the renderer averages the drawn tiles of each source and scales a later source's colors by the first source's mean over its own. Cheap (one multiply in the shader, a few dozen additions per frame), no extra passes.
2. **Histogram matching.** Matches contrast too, but needs histograms per tile and a lookup texture per source; much more code for the fixture-free cases the plan names.
3. **Feathered blending across the boundary.** Hides the edge but not a switch between levels, and needs both sources loaded on both sides.

## Decision

Option 1. Core marks each draw with its layer and chain position (`TileDrawList.toneSources`, -1 for draws that are not matched: single-source layers, base images, `harmonize: false`). The renderer's `ToneMatcher` sets each later source's gain to the reference's mean over its own from the frame's draws, clamped to ×0.5–×2, and keeps the last gain while either is out of view; the imagery a draw fades from keeps the gain of the source it was drawn as, so a cross-fade does not jump. Means are taken in sRGB and the shader multiplies linear texels, so the gain applied is the sRGB ratio to the power 2.2. Gains follow the view each frame without easing: an idle engine draws no further frame that could ease them in. `ImageryLayerOptions.harmonize` (default true) turns it off per layer.

## Consequences

- Means exist only for images a 2D canvas can draw (`ImageBitmap`, image and canvas elements); compressed (KTX2) tiles keep gain 1.
- Matching is global per source and view, not local: a source whose tone varies across the view is matched on average.
- `e2e/imagery-tone-matching.spec.ts` checks the boundary, the switch and the raw colors against the `toned` fixture pattern.

## Amendment, 2026-10-28: matching the imagery below (F633)

The Europe preset needs a layer's tones to follow the layer under it (the package's WorldCover over the Blue Marble,
the online orthophotos over both), which a chain cannot do: the package's water must be transparent. `harmonize:
'below'` matches every source of a layer to the imagery under it instead of to its chain's first source. Matching
over the whole view would compare unlike content (a land layer against land and sea), so each draw is compared where
both show: each tile's colors are kept on a 4 × 4 grid (not one mean), and for every cell of the surface tile the
layer's color and the color under it are summed, weighted by the layer's own alpha (keyed water and clipped borders
count for nothing). Under a translucent layer the reference is the draw's opaque imagery (with its own gain); under
an opaque one, the next layer down with a tile there (core's `belowTextures`), or the world base image, measured once
on a 256 × 128 grid. The gains stay per source and per view, clamped to ×0.5–×2, as before. The overlay slots' gains
travel in free numbers of the draw's matrices (one of them, the overlay fades' last element, read as 0 in the shader
on both backends, so `tones` column 2's y holds it). Tiles masked per pixel reach the renderer as RGBA pixels rather
than a bitmap (a canvas drops the color of transparent pixels, which drew a dark fringe), and their grids are taken
from those pixels.
