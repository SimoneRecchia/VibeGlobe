# 0184. A zoom stops before the surface; a flight frames whole models

- Status: Accepted
- Date: 2026-10-31
- Milestone: M6, M10 (F666, F667; KB-300, KB-301)

## Context

In the owner's application over a wind farm, a wheel zoom never stopped: the terrain collision kept the eye 10 m above
the ground by lifting the camera's target off it (F146), so the range fell toward zero, the zoom read 28 and the view
looked at a point in the air (KB-300). A flight to a turbine went to zoom 22 at its foot, while one to a solar field
worked: the fit framed one point with no size and aimed at the ellipsoid under the object (KB-301). The owner asked for
a zoom that stops a little before the terrain, mountains included, so the view always shows what it frames; for a
flight to an asset that frames it whole and centered; and for a flight to a plant that shows every device.

## Decision

- **The zoom stops at a distance from the surface it zooms toward.** `constraints.minSurfaceDistanceMeters`, 40 m by
  default: a zoom in by input is cut where the eye would come nearer the terrain under the cursor, as drawn. The step
  is solved against the range: a step of z levels moves the eye toward the target by range · (1 − 2^−z), and the
  terrain point lies nearer than the target where the terrain rises above the ellipsoid. Toward the sky a zoom goes on,
  the clearance under the eye holding as before. `0` restores the old reach (about 1 m, F061, F078), which the
  street-level scenarios use. API movements are not cut: an application that jumps close does so on purpose, and the
  clearance still holds.
- **A fit aims at the middle of what it frames.** The aim point moves along the view's central ray to the middle of the
  framed heights, the bounds lie at the lowest framed height, the eye stays at least 100 m from the middle, and
  `tiltDeg` may replace the view mode's tilt.
- **Model sets report their box.** The renderer gives each set's model box (`ModelRenderer.setBounds`), and
  `ModelSetLayer.framePositions(ids)` turns it into the corners of copies as drawn, at their scale, with the blades'
  reach round the tower. `fitObjects` frames a turbine whole, and a plant by its devices' boxes.

## Consequences

- A view never zooms into the ground or past what it can show; 40 m shows about 30 m of ground at the default field of
  view.
- Applications fly to assets with `fitObjects(globe, layer.framePositions([id]))`, and to a plant with every device's
  boxes (the models guide); the plant's own coordinates frame one point.
- The core bundle grew to 64.97 KB of its 65 KB budget, the renderer to 40.46 KB of 40.5 KB (with #89 merged).
