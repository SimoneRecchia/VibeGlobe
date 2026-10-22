# M5 Globe, map and 3D view: implementation plan

Feature entries F548, F150–F167 (F149 superseded by F548). Design: [ADR 0008](../adr/0008-globe-to-flat-morph.md) (option 5, the anchor-frame world-space morph), [ADR 0015](../adr/0015-owner-decisions-2026-10-20.md) decisions 8 and 9 (constant ground scale in pans; a 0° 2D band, tilt rising only at neighborhood scale), [ADR 0009](../adr/0009-camera-and-input.md) (camera and anchors), [ADR 0004](../adr/0004-precision-strategy.md) (precision). Survey: [globe to flat](../research/globe-to-flat.md).

## 1. Geometry in the engine's world space

ADR 0008 places the plane endpoint in the anchor's east-north-up frame A. The engine's world space stays eye-relative ECEF (ADR 0004): the plane endpoint is mapped into ECEF through frame A, which is linear, so the morph is unchanged and the camera, its matrices and frustum planes keep their ECEF definitions.

- Anchor a: the camera target on the ellipsoid; frame A its east, north, up axes in ECEF (rows of R_A).
- Globe endpoint of a vertex at (φ, λ, h): G = E(φ, λ, r·h).
- Plane endpoint: P = E(a) + R_Aᵀ·σ·(wrap(x − x_a), y* − y*_a, r·h·k(φ)), with x, y* EPSG:3857 meters (capped Mercator beyond ±85.0511°: y* continues linearly with the slope at the limit), k(φ) the Mercator scale factor clamped at the limit, σ = 1 / k(φ_a).
- Morphed position: M = (1 − m)·G + m·P. At m = 0 it is the globe exactly; the plane touches the globe at the anchor, so the camera pose (target, range, heading, tilt) needs no change with m and the screen center stays anchored (F156).
- Per tile, the CPU computes in float64 both tile-center offsets from the eye: the globe center (as today) and the plane center E(a) + R_Aᵀ·σ·(wrap(x_c − x_a), y*_c − y*_a, 0) − eye, each split into float32 high and low parts. Per vertex, the mesh carries its globe offset (as today), its normal, and its plane offset from the tile's plane center in Mercator meters plus its scale factor k (anchor-independent, so meshes are built once). The shader forms both endpoints with R_Aᵀ, σ, r and m as per-frame uniforms and mixes them explicitly.
- A float64 TypeScript reference of the same function serves picking, culling, collision, anchoring and tests.

## 2. Scope and order of work

Each increment ends with its features passing end to end, committed and pushed.

1. **Curves and morph core (F548, F150, F151).** `@vibeglobe/core` `view/`: typed, validated curve configuration (phase zoom ranges, smootherstep easing, automatic tilt default 50° within 45–60°, relief curve) driven by ground zoom z_g; the morph frame (anchor, R_A, σ, m, r) and the float64 morph of a point; capped Mercator; per-tile wrap. Unit tests of curve properties (continuity, zero slope at the ends, ordered ranges), endpoint and anchor identities, relief proportions, the cap's C¹ continuation.
2. **GPU morph (F152, F153, F157, F159, F160).** Mesh plane attributes, per-tile plane-center offsets, the vertex shader's two endpoints and the morphed normal for terrain displacement; morph-aware tile selection (morphed bounding spheres, ADR 0008's horizon rule, frustum on the morphed spheres) so the flat map culls correctly. Scenario `?scenario=morph-sweep` with frame differencing: no jump, no hole at the poles and across 180°.
3. **Anchors and picking (F155, F156, F158).** Ray against the morphed surface (float64 Newton, at most three steps, no allocation); `screenToGeo` and measurements on the ellipsoid; cursor-anchored wheel zoom through the morph (drift ≤ 1 px each frame), center-anchored API zoom.
4. **View modes and chosen vs applied values (F161–F166, F154).** Auto (default), 2D locked and manual tilt; the 2D / 3D / Auto API; chosen tilt and heading kept apart from applied ones; temporary clamps for terrain (F165) and empty sky (F166) restored smoothly. Relief scaled by k on the plane.
5. **Acceptance (F167).** A continuous zoom from the globe to an oblique street view on both backends: frame differencing finds no jump, the anchor holds, frame times within budget on the hardware run. One milestone review, one fix-only pass, the full CI run, the merge.

Long flights through the phases need `flyTo` (F195, M6): M5 makes every phase a function of the camera's zoom, so a flight passes through them; F195's tests check it.

## 3. Risks

- Software rasterizer cost of the extra vertex work: the morph adds two multiply-adds per component; scenarios use 320 × 240 canvases.
- Horizon culling during the morph: ADR 0008's angular cut is conservative; scenario images are compared with culling on and off.
- The plane's far side: per-tile wrap places the cut opposite the anchor; far tiles beyond the ellipsoid horizon distance are culled, so the cut never enters the view.
