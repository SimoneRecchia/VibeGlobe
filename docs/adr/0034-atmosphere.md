# 0034. Atmosphere: one single-scattering model for sky and haze, analytic light paths, fog-aware detail

- Status: Accepted
- Date: 2026-10-22
- Milestone: M11

## Context

M11 asks for a sky whenever the globe or the horizon shows, a limb glow that changes smoothly with altitude without banding, sky and haze that pass through the globe-to-flat morph and the tilt without a jump, haze that hides low-detail tiles near the horizon and saves their loads, and optional sun lighting with the terminator correct to 0.1° (F391–F396). It must look the same on WebGPU and forced WebGL2, allocate nothing per frame (ADR 0018) and fit the tablet budget. The [atmosphere survey](../research/atmosphere.md) covers CesiumJS, OpenGlobus, osgEarth, three.js, Babylon.js, Filament and the O'Neil, Bruneton-Neyret and Hillaire methods.

Since 2026-10-22 a parallel session builds the atmosphere as new files under `packages/renderer/src/atmosphere/` (`docs/parallel-tracks.md`); the main session wires it into the frame loop.

## Options considered

1. **Sky model.** Analytic ground-observer sky (Preetham): no view from space. O'Neil per vertex: a fitted scale function valid for one geometry, interpolation artifacts. Precomputed multiple scattering (Bruneton): costly precompute, static parameters, horizon precision issues. Hillaire's small per-frame LUTs: cheapest per pixel, but four render targets, half-float rendering on WebGL2 and device-loss restoration. Per-pixel single scattering ray-marched in the shader (Cesium's method, per fragment).
2. **Light-path optical depth.** An inner ray march per sample (Cesium: 4 steps), a transmittance LUT (Hillaire), or an analytic Chapman function.
3. **Haze.** Distance fog toward a constant color (three.js, Filament), or aerial perspective from the same model as the sky.
4. **Fog and level of detail.** None (OpenGlobus, osgEarth) or Cesium's screen-space error reduction by a fog factor.
5. **Sun position.** Simon 1994 through ICRF (Cesium), Schlyter's elements (OpenGlobus, osgEarth), or Meeus' low-precision solar coordinates.

## Decision

- **Model.** Single scattering by Rayleigh and Mie in exponential layers (scale heights 8 and 1.2 km, Bruneton's and Hillaire's sea-level coefficients, Cornette-Shanks Mie with g = 0.8, top at 80 km), ray-marched per sky pixel and per surface fragment with samples crowded toward the eye (t²). The light path's optical depth is analytic: the Chapman function's large-x form √(πx/2)·erfcx(√(x/2)·μ) with the Abramowitz-Stegun bound for erfcx, and below the horizontal twice the horizontal depth at the tangent point minus the upward depth; within 6% of brute-force integration at every angle above the ground. The Sun's share fades over ±1 km of the light path's lowest altitude, a soft Earth shadow. `atmosphere-model.ts` holds the model on the CPU; `atmosphere-nodes.ts` emits the same steps in TSL for both backends.
- **One model for sky and haze.** The sky shader marches to the top of the atmosphere (or the ground, adding a dim ground albedo where no tile is drawn); the surface shader marches to the fragment and returns color × light × transmittance + in-scattered light. Every constant and the display mapping 1 − exp(−0.6·L) are shared, so distant terrain fades into exactly the sky color at the horizon.
- **Precision.** Distances in km. Altitudes along a ray are h0 + (r_d² − r0²)/(r_d + r0) and crossings use the stable quadratic form with the discriminant written as (target − h0)(2r + target + h0) + (r0·μ)², so nothing subtracts the planet radius from a distance to the center at any radius. The CPU computes the eye's altitude in float64. The WGS84 ellipsoid is mapped to a sphere of radius a by scaling the polar axis by a/b; view rays and the Sun are scaled by the same axes, which maps the ellipsoid's normals to the sphere's, so N·L = 0 lies on the ellipsoid's true terminator.
- **Continuity.** One path inside and outside the atmosphere (the ray starts where it enters). The morph passes `morphFrame(flatness, height, up)`: the sphere's radius grows as R / (1 − t)² up to 1000 R and the polar scale fades out, so the horizon's dip shrinks linearly with no switch at either end. Without sun lighting the light stands behind the eye, so nothing switches with altitude.
- **Banding.** Triangular noise of ±1 step of 8 bits in a gamma-2 space, added after the display mapping in both shaders; a quality setting turns it off for tests.
- **Sun lighting.** Off by default. When on, the surface is lit by the transmitted sunlight × max(N·L, 0) with a 4% night ambient (never black), N being the ellipsoid normal; terrain normals plug in when M4 provides them. The Sun's direction comes from Meeus' low-precision solar coordinates and Greenwich mean sidereal time (`sun-position.ts`), within 0.02° of Astronomy Engine; changing the time updates a uniform only.
- **Fog-aware detail.** `surfaceVisibility(ray)` is the luminance-weighted transmittance from the eye to a point (8 samples, CPU). The engine multiplies a tile's screen-space error by it before the refinement test: a tile behind haze refines less, and one below 1% visibility never refines. It is pure TypeScript with no renderer dependency, so the main session can move it into core.
- **Quality.** `ATMOSPHERE_QUALITY` maps low, medium, high and ultra to sky samples 8, 12, 16, 24 and haze samples 4, 6, 8, 12. Counts are uniforms (dynamic loop bounds), so a preset change rebuilds no pipeline (F399).
- **Draw order and depth.** The sky is a full-screen triangle at depth 0, the far end of every depth path (ADR 0005), drawn with the greater-equal test and no depth write: it fills only pixels no surface wrote, whatever its position in the scene.

## Consequences

- Cost grows with pixels × samples: about 16 exponentials per sky sample and 8 per haze sample. On SwiftShader the harness renders 480×320 frames in a few ms; real-GPU and tablet timings are hardening work (`docs/hardening-backlog.md`). If the tablet budget is missed, Hillaire's sky-view and transmittance LUTs replace the per-pixel march behind the same interface.
- Single scattering only: twilight is darker than reality and there is no ozone; acceptable for a map engine, revisited only on request (`docs/follow-ups.md`).
- The atmosphere changes the look of imagery from orbit (a blue veil, as in photographs), so the engine's existing visual baselines change when the main session wires it in.
- The harness (`e2e/support/atmosphere.html`) draws the ellipsoid with the playground's imagery the way the engine does and runs every browser check on both backends; the entries pass once the engine draws the atmosphere and the same checks run in the playground.
