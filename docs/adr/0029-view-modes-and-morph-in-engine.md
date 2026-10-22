# 0029. The globe-to-flat morph in the engine, relief with tilt, and view modes

- Status: Accepted (decided by agent; owner may revisit)
- Date: 2026-10-22
- Milestone: M5

## Context

[ADR 0008](0008-globe-to-flat-morph.md) chose the anchor-frame world-space morph and left open how it meets the engine
built in M2 to M4, whose world space is eye-relative ECEF (ADR 0004) and whose terrain shows full relief at every zoom.
`PLAN.md` also leaves a few behaviors to the implementation:

- how relief behaves when the user tilts by hand below street scale, where the Auto curve keeps it flat;
- how a programmatic view with a tilt relates to the view modes;
- what "empty sky would fill the screen" means for the temporary tilt clamp (F166).

## Options considered

1. **World space.** (a) Move the camera and all culling into the anchor's east-north-up frame, as ADR 0008 describes.
   (b) Keep ECEF and map the plane endpoint into it through the anchor's frame: P_ecef = E(a) + R_Aᵀ·P. The morph
   stays a linear blend, so (a) and (b) give the same image.
2. **Relief below street scale.** (a) The zoom curve only: a view tilted by hand at region scale shows flat mountains.
   (b) The larger of the zoom curve and an easing of the applied tilt (0° to 30°): relief appears as soon as the view
   tilts, and a 0° view keeps the flat map the curve asks for.
3. **A view given with a tilt** (`view.tiltDeg`, `jumpTo({ tiltDeg })`). (a) Ignored in Auto. (b) A chosen tilt: the
   mode becomes manual, as when the user tilts by hand.
4. **Empty sky.** (a) A fixed maximum tilt per zoom. (b) The applied tilt stops where the ellipsoid's horizon would
   pass the top third of the screen at the camera's altitude, restored as soon as the horizon allows it.

## Decision

- **1(b).** The camera, its matrices and its frustum planes keep their ECEF definitions. Each tile carries a second
  center, its plane center in capped Web Mercator; each vertex its Mercator offset from that center, its skirt drop
  and k(φ). Per frame the CPU computes in float64 both centers relative to the eye and splits them (ADR 0004); the
  shader forms both endpoints and mixes them. The plane-center offset rides in the rotation part of the mesh's world
  matrix, which the engine's vertex node never uses as a rotation, so no per-object uniform is added (F064).
- **Anchor.** The camera target's longitude and latitude, on the ellipsoid. The plane is the anchor's tangent plane.
- **Selection.** Tiles are measured at their morphed positions (3 × 3 grid, bounding sphere, chord sag only for the
  globe's share). ADR 0008's horizon rule: the ellipsoid occluder at m = 0, the angular cut cos θ_s = −m / (1 − m)
  widened by the tilt for 0 < m < ½, none from ½. Terrain errors and relief ranges are scaled by the relief factor and
  by σ·k(φ) on the plane.
- **2(b).** r = max(curve(z_g), smootherstep(0°, 30°, applied tilt)).
- **3(b).** A view without a tilt keeps Auto; a view with one chooses that tilt (manual mode) until the mode changes.
- **4(b).** The sky clamp keeps the horizon at or below the top third of the screen.
- **Spherical Web Mercator on the ellipsoid.** EPSG:3857 is conformal on the sphere only: on the plane, north-south
  distances are N / M times true (0.34% at 45°) while east-west distances are exact at the anchor. The morph accepts
  this, as every Web Mercator map does.

## Consequences

- Picking, culling, collision and anchoring use one float64 morph function (`packages/core/src/view/morph.ts`); the
  pick is closed-form at m = 0 and m = 1 and a Newton solve between.
- M4's terrain tests keep their globe and full relief through `viewCurves` (no morph, relief from ground zoom −2).
- The owner may revisit the relief and sky rules; both are single functions of the view state.
