# 0009. Camera and input

- Status: Accepted (open points settled by 0015)
- Date: 2026-10-20
- Milestone: M2, M5, M6 (terrain collision in M4)

## Context

`PLAN.md` (Navigation and controls, Map experience) asks for navigation that feels like Google Earth and Google Maps:

- zoom anchored at the cursor, grab-pan on the globe and the flat map, rotate and tilt, inertia, and pinch, twist, two-finger tilt and taps on touch;
- `flyTo` along a van Wijk–Nuij curve, `easeTo`, `jumpTo` and tours;
- min/max zoom, max tilt, bounds and terrain collision, plus reduced motion and full keyboard operation;
- manual tilt and heading that persist, stored as chosen values separate from the applied ones;
- "All animations are frame-rate independent. Any user input interrupts a running animation and takes over smoothly, without a jump."

The feature list makes this concrete in F047, F048, F060 and F061 (M2), F146 and F147 (M4), F155, F156 and F163–F166 (M5), F168–F217 (M6), and F387 (M10).

`docs/plan/architecture.md` §2 (frame steps 1–4), §5 (chosen vs applied) and §11 (controls and animation) sketch the design; none of it is marked Proposed. The survey is [docs/research/camera-control.md](../research/camera-control.md). Related decisions:

- **Float64 camera math:** [ADR 0004](0004-precision-strategy.md).
- **Morph and zoom-driven curves:** [ADR 0008](0008-globe-to-flat-morph.md).

Forces found in the survey:

- **Collision and terrain loading:** jumps when terrain arrives come from post-hoc corrections and from re-sampling elevation mid-gesture (cesium#5999, maplibre#7989, maplibre#4233).
- **Inertia:** per-frame decay depends on the refresh rate (babylon.js#12820), and velocity measured up to the last move glides after a pause (maplibre#1303, leaflet#5652).
- **Hidden state:** hidden animation targets resurface after interruption (maplibre#2709).
- **Touch:** two-finger logic breaks when fingers report in separate events (cesium#9929) or are added late (openlayers#6485).
- **Wheel:** classifying the device and changing the zoom rate mid-gesture makes speed erratic (maplibre#5367, leaflet#4410).
- **Anchoring:** hand-written solves per projection break at poles, terrain and the horizon (maplibre#5296, maplibre#1024, webworldwind#432 and #787).

## Options considered

1. **Free camera mutated per input event** (CesiumJS `ScreenSpaceCameraController`).
   - **How:** the camera is an eye position and orientation. Each operation re-picks the globe and mutates the vectors. Inertia re-applies the last movement every frame, and collision lifts the eye after the fact.
   - **Pros:** the most general camera.
   - **Cons:** heading and tilt are derived, so "keep the user's tilt" has no home. Inertia depends on the frame rate. The collision clamp jumps when tiles load (cesium#5999). Flights disable input. Cesium itself replaced this design in 2026 with per-frame `Controller`s (cesium#13473).
2. **Target-based camera with per-projection helpers and eased inertia** (MapLibre GL JS).
   - **How:** center, zoom, bearing and pitch. Handlers return deltas that are merged and applied once per frame, and an allow list arbitrates between them. Anchoring is solved separately for Mercator and globe, and inertia becomes an `easeTo`.
   - **Pros:** proven at scale. The terrain elevation hold, the corrected copy for animations and the van Wijk–Nuij `flyTo` are all good ideas.
   - **Cons:**
     - Special cases multiply across projections, horizon and poles (many open issues).
     - Inertia starts at 30% of the release speed.
     - A wheel/trackpad classifier picks the zoom rate.
     - Chosen and applied are implicit (the requested vs the corrected transform), not a model concept.
3. **Geodetic target camera with explicit chosen/applied state, per-frame coalesced input, one anchor-constraint solver, and closed-form time-based motion.**
   - **How:** keeps the good ideas of option 2 and generalizes anchoring to one solver that runs through the renderer's projection, so it works in every phase.
   - **Pros:** every failure above has a structural answer, and the same code serves globe, morph, flat and tilted views.
   - **Cons:** a numerical solver instead of closed forms (a few float64 projections per frame), and new code to tune.
4. **Per-frame multiplicative damping or smoothing** (iTowns, three.js `OrbitControls` and `TrackballControls`, WorldWind Java move-to animators). Simple, but the trajectory depends on the refresh rate, which violates F203. Rejected.
5. **Other flight paths:** Cesium's power-8 height hump capped at 3 s, WebWorldWind's constant velocities, iTowns' eased rig lerp, and OpenLayers' chained zoom-out/zoom-in with linear resolution interpolation. These give uneven perceived speed and no principled duration. Rejected in favor of van Wijk–Nuij, which has an optimality argument and is proven in Leaflet and MapLibre.

## Decision

Option 3. Package placement follows architecture.md §1.

- **`core`:** camera state, chosen/applied resolution, the anchor solver, animations and collision.
- **`controls`:** DOM input, recognizers, velocity estimation and inertia. It drives the core API.

1. **Camera state (core, M2).**
   - **Fields:** target `{longitude, latitude, height}` (radians and meters, float64), `range` (meters, eye to target), `heading`, `tilt` (0 = looking straight down) and `roll` (0 for navigation; it exists for F047). Eye, view and projection matrices are derived each frame in float64 ([ADR 0004](0004-precision-strategy.md)).
   - **Zoom:** range (ground scale) is the zoom state, and the ground zoom z_g of [ADR 0008](0008-globe-to-flat-morph.md) is a log2 function of it. All zoom input and animation run in zoom units, so equal input gives equal perceived scale change at every altitude.
   - **Pans keep range:** pans and orbits never change range, so they never move the morph, tilt or relief curves (the follow-up ADR 0008 asks for). The public Mercator-convention `zoom` = z_g − log2 k(φ_target) therefore drifts slightly with latitude in the flat phase (about 0.023 per 100 km at 45°). The owner must confirm that trade-off (ADR 0008).
2. **Chosen vs applied (M5)** for tilt, heading **and range**.
   - **Target values:** target tilt is the Auto curve in Auto mode, 0 in 2D, and chosen tilt in manual mode. Heading is always chosen.
   - **Constraints:** applied values come from the targets through the constraints (max tilt, sky limit by altitude, min/max zoom, bounds, terrain clearance) and nothing else. A tightening constraint applies at once. A loosening one relaxes applied toward chosen with `1 − e^(−dt/τ)` (τ = 0.25 s to start).
   - **Continuity:** constraints are continuous functions of continuous inputs (the displayed, geomorphed surface; altitude), so applied values never jump.
   - **Gestures:** a gesture that manipulates a parameter first sets chosen to applied, then applies its deltas, so input always starts from what is on screen. A gesture never stores a value beyond a current hard limit.
   - **Refinement:** extending chosen vs applied to range refines architecture.md §5. It keeps a collision from leaving a permanent zoom change.
3. **Input capture (controls, M2 basic, M6 complete).**
   - **Events:** Pointer Events with `setPointerCapture`, `pointercancel` handling and `touch-action: none` on the map. A non-passive `wheel` listener calls `preventDefault` only over the map (F189). On Safari, `gesturestart` and `gesturechange` provide trackpad pinch and rotation. Keyboard input arrives on the focusable container. The `contextmenu` event is suppressed while rotate-drag is enabled.
   - **Coalescing:** DOM handlers only record into an input state: per pointer, the latest position and a ring of timestamped samples (`event.timeStamp`, last 150 ms); wheel accumulators; key states. They do no camera math.
4. **Recognizers run once per frame (frame step 2)** on that state and emit intents: `pan(anchor, pixel)`, `zoomAt(pixel, Δzoom)`, `orbit(pivot, Δheading, Δtilt)`, plus keyboard velocities. Starting values, tuned in M6:
   - **Mouse:** primary drag pans. Right-drag or Ctrl+primary orbits the screen-center target at 180° heading per viewport width and 90° tilt per viewport height.
   - **Wheel:** one continuous mapping, `Δzoom = −Δy_px / 300` (line and page deltas converted to pixels). Ctrl-pinch, meaning `ctrlKey` without a physically pressed Ctrl, uses `/100`.
     - **Smoothing:** device class only selects the smoothing constant: τ = 0.1 s for notch-like events (line or page mode, or integer |Δ| ≥ 50 px) and none otherwise.
     - **Lead cap:** the wheel target may lead the camera by at most 2 levels.
     - **Inertia:** none for the wheel; macOS momentum events pass through as continuous input.
   - **Two fingers:** the recognizer starts undecided.
     - **Tilt:** if the fingers are side by side (|dx| > |dy|) and both move at least 3 px vertically in the same direction within 100 ms, it locks into an exclusive tilt.
     - **Otherwise:** it combines pan about the midpoint, zoom (after 0.1 levels) and rotation about the midpoint (after 25 px along the circumference of the smallest finger circle). Each starts from its own unlock frame, so nothing catches up.
   - **Taps:** a tap moves ≤ 10 px and lasts ≤ 250 ms. A double tap or double click (≤ 300 ms, ≤ 20 px apart) zooms in one level anchored at the point. A two-finger tap zooms out one level about the midpoint. Shift+drag draws a zoom box.
   - **Finger changes:** any pointer add or remove re-baselines anchor, distance and angle with zero delta. Lifting to one finger continues as a pan, and inertia never resets live pointers.
   - **Keyboard:** arrows, Shift+arrows and +/− set target velocities that the camera approaches with exponential smoothing integrated exactly over `dt`. Each +/− press adds one level to the smoothed zoom target, so rapid presses accumulate.
5. **Anchor-constraint solver (core, M2; extended in M5).**
   - **Constraint:** every anchored operation is "geodetic point A, at its height frozen when the gesture starts, stays at pixel p", applied together with the change of range, heading or tilt.
   - **Solve:** a 2×2 Gauss–Newton on the target (longitude, latitude), with the heading held, through the same projection the renderer uses: globe, morph factor, flat, tilt and relief scale. It warm-starts from the last frame and needs 1–3 iterations to reach under 0.01 px. This is the Newton solve ADR 0008 specifies for the morph: the same code keeps the cursor or screen-center point fixed during the morph (F155, F156).
   - **Picking:** anchors and pivots are picked on the _displayed_ surface by a float64 CPU ray cast against the drawn terrain tiles, falling back to the ellipsoid or plane. It is synchronous on both backends; WebGPU readback is asynchronous.
   - **Ill-conditioned cases:**
     - **Near the poles in the globe phase**, when the heading-held system is singular, the solver switches to a free rotation (versor). The resulting heading change is written to chosen, because the user caused it.
     - **Near the horizon**, when the cursor ray grazes or misses the surface, it blends toward a screen-center anchor by grazing angle.
6. **Inertia (controls).**
   - **Velocity:** measured per channel (pan, heading, tilt, pinch zoom) from pointer timestamps over the 80 ms ending at release. At least two samples are required, so a pause gives zero velocity.
   - **Motion:** `x(t) = v0·τ·(1 − e^(−t/τ))`, evaluated at absolute engine-clock time since release. This is closed form and continuous in velocity at release. Starting values: τ = 0.2 s for pan and rotation, 0.15 s for tilt and zoom, and a 2,500 px/s cap. Inertia stops below 0.1 px of remaining motion.
   - **Horizon:** pan inertia is clamped so the anchor never crosses the horizon.
7. **Animations (core, M6).**
   - **Model:** an animation is a pure function of engine-clock time. The clock is the rAF timestamp with `dt` clamped to 100 ms (architecture §2), so the path is the same at every refresh rate and after stalls. One animation owns the camera at a time, and tours queue animations.
   - **`flyTo`:** van Wijk–Nuij with _u_ the geodesic distance between targets (Karney), _w_ the visible ground width at the target, ρ = 1.42 and V = 1.2 screenfuls per second.
     - **Peak cap:** ρ ← min(ρ, √(2·w_max/u1)), where w_max is the full-globe view.
     - **Easing:** cubic ease-in-out applied to _s_; duration S/V, clamped to the option bounds.
     - **Degenerate paths:** u1 ≈ 0 uses exponential zoom; no change uses `easeTo`.
     - **Orientation:** heading and tilt are kept unless the call specifies them, and the chosen/applied stage clamps tilt by the sky limit at the peak. Phases follow from zoom (F196).
     - **Terrain:** the destination height is refined mid-flight by re-anchoring the height interpolation so the current value is unchanged. The final frame is exactly the target.
   - **Other movements:** `easeTo` interpolates log-range, the geodesic center, the shortest heading arc and tilt. `jumpTo` applies in one frame. `fitBounds` solves range for any heading and tilt, including bounds across the antimeridian and the poles.
   - **Interruption:** any intent stops the running animation before its first delta and continues from the applied state. A programmatic call during an animation starts from the current state with an easing whose initial slope matches the current speed.
   - **Settling:** promises resolve on completion and reject with an `AbortError` that carries the cause. `movestart`, `move` and `moveend` carry the cause (F200).
   - **Reduced motion:** flights become a fade of at most 300 ms around a `jumpTo`, and inertia τ is quartered (F214).
8. **Terrain collision (core, M4; animations M6).**
   - **Rule:** the eye and the near-plane corners must clear the displayed surface by `minClearanceMeters` (default 1 m) plus the near-plane margin. Correction order: applied tilt first, then applied range.
   - **Height source:** a `SurfaceHeightProvider` interface supplies heights. The terrain implementation answers from exactly the drawn, geomorphed tiles; 3D Tiles join in M13.
   - **During gestures:** target height and anchor heights are frozen.
   - **Afterwards:** the target is re-seated onto the terrain under the screen center by changing target height and range together, so the eye and the view do not move.
   - **Animations:** keep applied range above the clearance each frame (F212).

## Consequences

- **Easier:**
  - Every anchored behavior (F060, F061, F155, F156, F168–F173, F178, F180, F184, F192) is one tested solver, not a set of per-projection derivations.
  - Persistence rules (F163–F166, F215, F216, F201) and constraints (F209–F211) follow from one resolution stage.
  - Frame-rate independence (F203) and interruption (F202) hold by construction, not by tuning.
  - Recognizers are pure functions of an input snapshot, so they can run wherever the frame is computed if the M2 OffscreenCanvas evaluation moves rendering to a worker.
- **Harder:**
  - The solver needs ill-conditioning detection and careful fallbacks (poles, horizon).
  - Touch thresholds and inertia constants need device tuning.
  - Safari needs a separate gesture-event path.
  - Multi-touch end-to-end tests need CDP touch injection on Chromium and real tablets for WebKit.
- **Follow-ups:**
  - **M2:** camera state and derived matrices, the solver with drag and wheel zoom, the engine clock.
  - **M4:** `SurfaceHeightProvider` and collision.
  - **M5:** chosen/applied stage, sky limit, morph anchoring.
  - **M6:** recognizers, inertia, animations, keyboard, reduced motion, and tuning on the reference devices. The survey records the constants it measured.
- **Verification:**
  - **M2:** property tests (Vitest, seeded) over random states, including poles, antimeridian, tilt, terrain and morph factor, show anchor drift ≤ 0.01 px for pan, zoom-at and orbit.
  - **M4/M6:** a collision scenario with steep relief and delayed fine tiles asserts the clearance in every frame and no frame-to-frame eye jump above the scenario bound.
  - **M6:**
    - **Frame-rate independence:** the same scripted input timeline replayed at 30, 60, 120 and 144 Hz and with 500 ms stalls yields identical sampled trajectories (relative error ≤ 1e-9).
    - **Interruptions:** injected at random times show zero position discontinuity, and promises settle with the right cause.
    - **Inertia:** a release after a 100 ms pause does not coast.
    - **Flights:** `flyTo` endpoints are exact, the path is continuous, and Milan→Tokyo reaches the globe phase.
    - **Touch:** recognizer timelines cover tilt vs pinch vs twist and finger add/remove.
    - **Performance:** controls cost ≤ 0.2 ms CPU per frame with zero allocations, a CPU pick ≤ 0.1 ms, and input-to-frame latency measured on WebGPU and WebGL2.

## Update 2026-10-20

The owner confirmed the defaults ([ADR 0015](0015-owner-decisions-2026-10-20.md), decisions 8 and 10): constant ground scale while panning in the flat 2D phase, and free rotation near the poles with no jump and never an automatic north-up. No change to this ADR's decisions.

## Update 2026-10-21

The first M2 controls did the camera math in the DOM handlers: every `pointermove` and `wheel` event ran a full anchor solve, against points 3 and 4 (M2 review). Now:

- **Input capture.** The handlers only record: the pointer's latest position, a pending grab, and the wheel delta accumulated with its latest position (`packages/controls`). They ask the engine for a frame (`NavigationApi.requestUpdate`).
- **Once per frame.** At the start of each frame (step 2), before the camera is updated, the engine calls the controls' `update()`, which turns the recorded input into at most one grab, one `dragTo` and one `zoomAt`. Several events between two frames cost one solve; the grab waits for the first move, so a click without motion costs no frame; a release applies the last position first. Intents made during the frame do not schedule another frame.
- **Grazing horizon.** The blend toward a screen-center anchor (point 5, ill-conditioned cases) belongs with the solver's tilt and morph extension in M5, where tilted views and the flat phase make grazing rays common. In M2 a drag whose pixel leaves the globe keeps the last solvable camera, and the pole case uses the free rotation already implemented.
- **Anchor accuracy.** The solver iterates to 0.001 px and succeeds only within 0.01 px, the drift point 5 allows; the rigid fallback near the poles repeats its rotation up to four times, since each is exact only for a sphere. Property tests check pan and zoom-at steps with tilt up to 60°, near both poles and across the antimeridian, and that at least 99% of realistic drag steps solve (`anchor.test.ts`, second M2 review).
