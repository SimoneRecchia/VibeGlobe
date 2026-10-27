# 0008. Globe-to-flat morph

- Status: Accepted (partly superseded by 0013; open points settled by 0015)
- Date: 2026-10-20
- Milestone: M5

## Context

`PLAN.md` (Map experience: globe, 2D and 3D) asks for one continuous camera that shows:

- a WGS84 globe at world and continent scale;
- a morph to a flat Web Mercator map at country scale;
- a flat map at region and city scale;
- a gradual tilt to 45–60° with full relief at street scale.

Every transition must be a smooth function of zoom with no jump. The morph must interpolate positions between the ellipsoid and the plane on the GPU, "as MapLibre does". The point under the cursor (or at the screen center) must stay fixed while flattening. On the plane, heights are scaled by the projection's scale factor. Measurements stay on the ellipsoid. Poles and the antimeridian show no gaps or seams. Feature list entries F149–F162 make these testable, and later entries require data layers, vector tiles, 3D Tiles and the atmosphere to stay continuous through the morph.

The survey is [docs/research/globe-to-flat.md](../research/globe-to-flat.md). Its findings that drive this decision:

- **MapLibre's blend is a world-space interpolation in disguise.** MapLibre (v6.15.0) blends clip-space x, y and w from a globe matrix and a Mercator matrix that share one camera relative to the map center. That is equivalent to a world-space interpolation in the center's tangent frame. It runs only at zoom 11–12, where the two surfaces differ by at most about 2 px. CPU picking, collision and anchoring use one endpoint, which produced [#6542](https://github.com/maplibre/maplibre-gl-js/issues/6542), [#8714](https://github.com/maplibre/maplibre-gl-js/issues/8714) and [#7660](https://github.com/maplibre/maplibre-gl-js/issues/7660). GPU trigonometry produced [#7419](https://github.com/maplibre/maplibre-gl-js/issues/7419).
- **CesiumJS (1.146) morphs on time, not zoom.** It morphs world positions over a time-based tween, sends the camera to a fixed overview when animated ([#2065](https://github.com/CesiumGS/cesium/issues/2065)), disables relative-to-center rendering, hides 3D Tiles while morphing, and leaves Columbus-view heights unscaled.
- **deck.gl (v9.4.0) switches discretely at zoom 12.** The switch causes jumps ([#10804](https://github.com/visgl/deck.gl/issues/10804)) and stale tile frames ([#10870](https://github.com/visgl/deck.gl/issues/10870)). It does scale heights per vertex by 1/cos φ.
- **OpenGlobus has no flat map.** It fills polar caps with geographic-scheme quadtrees beside the Mercator one.
- **The country-scale band is a large geometric change.** At the band's midpoint the globe and the plane differ by about 47 px of sagitta at the edge of a 1080-px view. A blend that only works when the endpoints nearly coincide is not enough.

## Options considered

1. **Clip-space blend of two synchronized cameras (MapLibre).**
   - Pros: proven in production; each endpoint keeps its own well-tested camera.
   - Cons:
     - Only the screen center is exactly anchored.
     - CPU paths do not see the blend (#6542, #8714).
     - Clip-space z must be faked.
     - Elevation handling must be duplicated in two cameras (#7660).
     - The pole fans are hidden during the blend.
     - It is acceptable only where the endpoints differ by a pixel or two, not across a country-scale band.
2. **Time-based scene-mode morph (CesiumJS).**
   - Pros: simple world-space lerp in the vertex shader.
   - Cons:
     - Not zoom-driven, which contradicts `PLAN.md`.
     - When animated, the camera flies to an overview and the location is lost (#2065, still open).
     - User input snaps the morph to its end.
     - Relative-to-center rendering is disabled (jitter).
     - 3D Tiles are hidden.
     - Mercator relief is unscaled.
     - In 2D the world is rendered twice, with known culling and picking bugs (#10484, #8768).
3. **Discrete projection switch (deck.gl `GlobeView` at zoom 12).**
   - Pros: no morph code.
   - Cons: a visible jump by definition (43 px under SwiftShader, #10804); tile data cached in one frame breaks in the other (#10870). It violates the no-jump requirement.
4. **Globe only with per-region projections (OpenGlobus).**
   - Pros: polar caps from geographic tiles.
   - Cons: no flat map, so it does not meet the requirement. Its cap idea is adopted below.
5. **Anchor-frame world-space morph on the WGS84 ellipsoid (MapLibre's geometry, generalized).**
   - How it works: one camera lives in the east-north-up frame of its target point (the anchor). Every vertex carries a precomputed globe offset and plane offset, and the vertex shader linearly interpolates them in that frame. One morph function is shared by the CPU (float64) and the GPU (float32, relative to center).
   - Pros:
     - The center anchor holds by construction.
     - The cursor anchor is solved exactly.
     - Every subsystem sees the same geometry.
     - Precision is kept and real depth is used.
     - There is no GPU trigonometry.
   - Cons:
     - +8 bytes per vertex.
     - A Newton solve per frame during cursor zoom.
     - Culling must be morph-aware.
     - Content without both positions (3D Tiles, glTF) needs a per-tile approximation.

## Decision

Option 5. It is the only option that meets the zero-jump and anchor requirements across a country-scale band. By construction, it avoids every failure class found in the four issue trackers: two cameras, CPU/GPU divergence, mode switches, GPU trigonometry and duplicated worlds.

**Morph geometry.**

- The anchor _a_ is the camera target, including its relief-scaled terrain height. Frame A is the east-north-up frame at _a_.
- For a vertex at geodetic (φ, λ, h) with relief factor r:
  - Globe endpoint: G = R_A·(E(φ, λ, r·h) − E(a)), with E the WGS84 geodetic-to-ECEF conversion.
  - Plane endpoint: P = σ·(wrap(x − x_a), y\* − y\*_a, r·(h·k(φ) − h_a·k(φ_a))). Here x and y\* are EPSG:3857 meters, k(φ) = sec φ·√(1 − e² sin² φ) clamped at ±85.0511°, and σ = 1/k(φ_a).
  - Morphed position: M = (1 − m)·G + m·P, written explicitly (never `mix`). Normals are normalize((1 − m)·n_G + m·n_P).

**Camera and anchors.**

- The camera pose in frame A (distance, heading, tilt) does not depend on m, so the screen-center anchor never moves.
- Cursor-anchored zoom picks the geographic point under the cursor on the morphed surface when the gesture starts. Each frame it solves the target's (φ, λ) with a float64 Newton iteration (at most 3 steps, no allocation) so that point stays under the cursor. The solve is damped toward the center anchor near the limb or off the surface.

**Curves.**

- Morph m, Auto tilt and relief r are smootherstep functions of ground zoom z_g = zoom + log2 k(φ_target), which is independent of latitude.
- Defaults, in the MapLibre zoom convention, are to be tuned in M5:
  - m from 0 to 1 over z_g 4.0 to 6.5;
  - r from 0 to 1 over 10.0 to 15.0;
  - Auto tilt from 0° to 50° over 14.0 to 16.5.
- Validation rejects unordered ranges and requires m = 1 before tilt exceeds ε, unless the configured overlap allows otherwise.

**Relief.** Per-vertex k(φ) normalized at the anchor, computed in the shader from Mercator y with `exp` only (k = cosh(Y/a)·√(1 − e²·tanh²(Y/a))).

**Vertex data and precision.**

- Workers compute each vertex's globe offset (3×f32, relative to the tile's globe center), plane offset (2×f32) and height in float64.
- Per tile, the CPU passes both tile-center offsets from the eye as float32, so relative-to-center precision holds at every m.
- The GPU never evaluates trigonometry for positions.

**Poles.**

- Caps beyond ±85.0511° are geographic-scheme tiles with a full vertex row at ±90°.
- On the plane they use capped Mercator: y is continued linearly with C¹ continuity at the limit.
- They are textured from the pinned global fallback and never hidden during the morph.

**Antimeridian.**

- Each tile is placed at the wrap copy nearest the anchor (per tile, never per vertex).
- The single cut is the meridian opposite the anchor. The far plane is capped at the ellipsoid horizon distance for the camera altitude, with haze covering the cap, so the cut never enters the view.
- No world copies are drawn.

**Culling and depth.**

- Each tile gets a morphed bounding sphere: center (1 − m)·c_G + m·c_P, radius (1 − m)·r_G + m·r_P.
- Horizon culling uses the ellipsoid occluder at m = 0. For 0 < m < ½ it uses a conservative angular cut around the anchor at cos θ_s = −m/(1 − m), widened by tilt. From ½ on there is no horizon cut.
- Near and far planes are fitted to the morphed spheres.

**One function everywhere.**

- The same morph serves terrain, imagery, data layers (lines and polygons tessellated), picking, label placement and collision, bounding volumes and terrain clamping.
- 3D Tiles and glTF use the morph's per-tile Jacobian (an affine approximation).
- Public picking and measurement APIs return geographic coordinates only.

**Changes to `docs/plan/architecture.md` §5.** §5 is not marked Proposed; this ADR settles it as follows.

- **Morph:** confirmed. The plane endpoint is now defined in the anchor's tangent frame scaled by σ. The camera up vector needs no mix because the camera lives in frame A.
- **Anchor:** confirmed with a change. The center anchor holds by construction. The cursor anchor is a Newton solve of the target in geographic coordinates, not a camera translation in morph space, which would break the frame's anchoring.
- **Curves:** confirmed, with ground zoom as the driving variable.
- **Relief:** changed. The scale factor is per vertex, k(φ), normalized at the anchor, not the anchor latitude's factor for every vertex. This matches F157 and keeps proportions correct away from the anchor in tilted views (9% error 300 km north of a 60° anchor otherwise).
- **Poles:** changed. Caps are not clipped on the flat map. They continue as a capped-Mercator strip, which F160 requires in the flat phase and in tilted views.
- **Antimeridian:** changed. Per-tile wrapping relative to the anchor replaces a horizontally repeating flat map.

## Consequences

Easier:

- One camera and one geometry definition, so no mode-specific state.
- F156 holds by construction.
- Panning across 180° has no special case.
- Picking, labels and data layers are exact during the morph.
- CI on SwiftShader matches hardware, because there is no GPU trigonometry.

Harder:

- +8 bytes per vertex.
- Per-tile uniforms for two offsets.
- A Newton solve during cursor zoom.
- Morph-aware culling.
- Terrain meshes must be per-tile buffers carrying globe offsets; a shared grid needs a variant shown to be sub-millimeter, to be settled by the GPU and level-of-detail ADRs.

Follow-up:

- The camera-control ADR should keep ground scale constant during pans, so pans never change the curves. In the 2D phase this drifts Mercator zoom by about 0.023 per 100 km at 45°, and the owner must confirm that trade-off.
- The `PLAN.md` sentence "tilt starts as the map finishes flattening" conflicts with its own tilt-0 2D band. The defaults follow the table.

Verification in M5:

- **Anchor:** drift ≤ 1 px every frame for cursor and center anchors (F155, F156), with the Newton iteration count recorded.
- **Parity:** the TSL and TypeScript morphs agree within 0.1 px on WebGPU, WebGL2 hardware and SwiftShader.
- **Continuity:** `?scenario=morph-sweep` frame differencing shows no jump and no geometry re-upload (F152).
- **Culling:** images are pixel-identical with culling on and off across the sweep, including max manual tilt and 85° latitude.
- **Relief:** the cone fixture has equal height-to-base ratios at 0°, 45° and 70° (F157).
- **Poles and antimeridian:** zero sentinel pixels at 80°N and 80°S during the sweep (F160), and in the 2D pan across 180° (F159).
- **Curves:** curve properties and phase ranges (F149, F150).
- **Cost:** added GPU time ≤ 0.3 ms per frame on the reference desktop and tablet. Otherwise add shader variants for m = 0 and m = 1. Record the measurements in this ADR's follow-up.

## Update 2026-10-20

The owner confirmed both follow-up points ([ADR 0015](0015-owner-decisions-2026-10-20.md), decisions 8 and 9): pans keep ground scale constant in the flat 2D phase, accepting the small Mercator-zoom drift; and the phase table holds, with a 0° 2D band at region and city scale and tilt rising only at neighborhood scale, each curve easing in and out at its ends. `PLAN.md` now says so, and F548 replaces F149.

## Update 2026-10-26: the caps stay round (KB-211)

The plane endpoint cannot show the caps beyond ±85.0511°: zoomed in on a pole, every view mode flattened into the Mercator plane, where the cap was a band ending in a line at the pole with nothing beyond it (a crescent in the view), and its wedge tiles were stretched into stripes. The morph factor is now multiplied by a cap factor of the view: smootherstep of the target's latitude distance to the nearer cap edge, from 1 to 2 view radii (the ground distance from the screen center to a corner, lengthened by 1 / cos(tilt), at most fivefold). A view that reaches a cap stays a globe at every zoom and in every view mode; elsewhere the curves are unchanged, so the morph factor is still a smooth function of the zoom and, panning, of the latitude. In a 320 × 240 view the curves are unchanged below about 67° at every zoom, and below about 76° from ground zoom 5.

The caps no Web Mercator source covers show a fill color, `GlobeOptions.polarCapColors` and `Globe.setPolarCapColors` (default: the Natural Earth base image's sea in the north, its ice in the south), `#rrggbb` colors drawn by the renderer as a 1 × 1 texture under the imagery handles -2 (north) and -3 (south). The base image's polar rows, stretched around the pole, showed as radial stripes. A geographic (EPSG:4326) imagery source that covers a cap shows there instead, as before.
