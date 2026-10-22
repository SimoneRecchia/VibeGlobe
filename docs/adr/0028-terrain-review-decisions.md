# 0028. Terrain collision, morph limits, grid sizes and fallback skirts (M4 review)

- Status: Accepted (decided by agent; owner may revisit)
- Date: 2026-10-22
- Milestone: M4

## Context

The M4 milestone review found places where two feature entries pull against each other, or where the M4 design
(ADR 0006, ADR 0027) left a gap:

- **Collision (F146, F147).** F146 wants the eye at least the clearance above "the terrain at the camera position
  (finest loaded level)" in every frame; F147 wants the eye lifted smoothly, over several frames, when finer terrain
  arrives above it, and never below the displayed surface. When a finer tile becomes resident more than the clearance
  above the displayed (coarser, or still morphing) surface, both cannot hold in the same frame.
- **Morphs across many levels (F138).** KB-079 limited morphs to two levels: a morph from a fallback many levels
  coarser opened cracks of kilometers. A tile whose relief changes by more than two levels in one frame still switches
  at once.
- **Grid sizes (F134).** Grids stopped at 64 cells. On rough real tiles (256 px Terrarium in the Alps), no grid of at
  most 64 cells meets the error bound, and the measured error was ignored.
- **Fallback skirts (F137, F139).** Skirts are sized for the terrain level a tile's surface level wants. A tile drawing
  a fallback ancestor many levels coarser, next to a neighbor showing its own level, can differ from it by far more.

## Options considered

1. **Collision**
   - (a) A hard floor at the finest resident terrain plus the clearance. Meets F146 literally, but the eye jumps when
     finer terrain arrives, which breaks F147.
   - (b) The clearance only above the displayed surface. Smooth, but the eye may stay inside resident terrain that is
     not yet shown.
   - (c) The clearance above the displayed surface at once, plus catching up with the finest resident terrain within a
     few frames.
2. **Morphs across many levels**
   - (a) Morph any gap. This brings back KB-079's cracks.
   - (b) Morph up to two levels, and seed new tiles from ancestors or descendants up to two levels away. Larger changes
     (camera cuts such as `jumpTo`, or missing levels) switch at once.
3. **Grids**
   - (a) Keep 64 cells and report the error.
   - (b) Allow 128 and 256 cells where the tile has the pixels, or where the mesh needs them, and refine the surface
     up to two levels beyond the finest terrain's own levels so it samples every vertex of such a grid.
4. **Fallback skirts**
   - (a) Size every skirt for the worst fallback. Skirts of kilometers make fill cost explode (KB-080).
   - (b) Per draw, lower the skirts further by twice the error of the coarser terrain actually shown.

## Decision

- **Collision: 1(c), in `liftMeters`.**
  - The clearance holds above the surface as shown, so finer terrain lifts the eye as it morphs in (F147).
  - Where the finest resident terrain lies higher than what is shown, the eye catches up by a quarter of the gap per
    frame, at least half a meter, so it is never more than a few frames behind (F146).
  - Where no drawn tile shows terrain under the eye, the finest resident terrain stands in for the displayed surface
    (KB-081).
  - F146's "every frame" is read against the surface as displayed, which is what the viewer can collide with; the
    finest resident terrain is reached within a few frames.
- **Morphs: 2(b).** A camera cut may switch relief at once, which is not a pop during motion. Continuous motion
  changes the selection by at most a level or two per frame, so its new tiles morph.
- **Grids: 3(b).**
  - Heightmaps use the coarsest grid of 8 to 256 cells, never more cells than pixels, that meets the bound.
  - Quantized-mesh tiles are rasterized at 64 cells, doubled up to 256 while the mesh's vertices miss the bound.
  - The measured error travels with the grid and widens the tile's relief range.
  - Smooth tiles still use small grids, so memory grows only where the relief needs it.
- **Skirts: 4(b).** `TileDrawLayer.skirtMeters` carries the extra depth per draw. The mesh marks its skirt vertices by
  a doubled normal, and the shader lowers them by that depth.

## Consequences

- **Collision:** `packages/core/src/terrain/collision.test.ts` tests the lift arithmetic. `e2e/terrain-camera.spec.ts`
  tests F146 and F147 end to end.
- **Morphs:** `previousLevel` is tested in `packages/core/src/terrain/terrain-draws.test.ts`.
- **Grids:** `packages/core/src/terrain/grid-size.test.ts` has a rough-relief case that needs more than 64 cells.
- **Skirts:** a regression test in `packages/core/src/globe/terrain-globe.test.ts` checks that fallback draws get deeper
  skirts.

## Note on F135 step 2

The step asks for screenshots of an analytic mountain compared "against analytically generated baselines". It is met in
two parts:

- The relief test probes 100 points over the fixture's analytic mountain on both backends. At each point, small quads
  just above and just below the analytic height (computed in Node from the fixture's terrain function, not by the
  engine) must show and stay hidden respectively. This compares the rendered depth with the analytic surface wherever
  it is sampled.
- The canonical terrain views (`e2e/visual.spec.ts`, including `terrain-smooth` across backends) guard the full
  image.

An image ray-traced in Node from the analytic function would duplicate the camera model in the test. The probes check
the same thing without that duplication.
