# Camera control

Research survey, written 2026-10-20 in M1, to be extended in M6. Decision: [ADR 0009](../adr/0009-camera-and-input.md).

## 1. Scope and the requirements it serves

This survey covers how the camera is represented and driven by input: zoom anchored at the cursor, grab-pan on a globe and on a flat map, rotate and tilt, inertia, programmatic flights (van Wijk and Nuij), terrain collision, touch gestures and how to tell them apart, frame-rate independence, and interruption without jumps.

Requirements served (`PLAN.md`):

- **Navigation and controls:** every zoom, pan, rotate/tilt, orientation, view and movement-API capability in the table. "All animations are frame-rate independent. Any user input interrupts a running animation and takes over smoothly, without a jump."
- **Map experience:** the cursor (or screen-center) point stays fixed during the globe-to-flat morph. Manual tilt and heading persist through zoom, phases and flights. Chosen and applied values are stored separately. Long flights pass through the phases.
- **Constraints:** min/max zoom, max tilt, geographic bounds, terrain collision. **Accessibility:** keyboard operation and reduced motion. **Targets:** 60 fps with p95 ≤ 16.7 ms, no stutter, no jumps.
- **Feature list:** F044, F045, F057 and F058 (M2); F140 and F141 (M4); F149, F150 and F157–F162 (M5); F164–F212 (M6).
- **Architecture:** `docs/plan/architecture.md` §2 (frame steps 1–4), §5 (chosen vs applied) and §11 (controls and animation).

## 2. Projects studied

| Project                                     | Version / commit                                                                                                   | License        | Files read                                                                                                                                                                                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CesiumJS                                    | 1.146.0, [`621826d`](https://github.com/CesiumGS/cesium/tree/621826db344eb7f1248f6bd50ed4770563127f12)             | Apache-2.0     | `packages/engine/Source/Scene/ScreenSpaceCameraController.js`, `CameraEventAggregator.js`, `CameraFlightPath.js`, `Camera.js` (flight cancel), `Scene/Controllers/*` (new 2026 controller API), `Core/ScreenSpaceEventHandler.js`; specs `ScreenSpaceCameraControllerSpec.js`, `CameraFlightPathSpec.js` |
| MapLibre GL JS                              | 6.15.0, [`95c7031`](https://github.com/maplibre/maplibre-gl-js/tree/95c703172ab9d745eb809672006f68775cef7400)      | BSD-3-Clause   | `src/ui/handler_manager.ts`, `handler_inertia.ts`, `camera.ts`, `handler/*.ts`, `geo/projection/*camera_helper.ts`, `util/time_control.ts`; tests `handler_inertia.test.ts`, `camera.test.ts`, `handler/*.test.ts`, `test/integration/browser/browser.test.ts`                                           |
| OpenLayers                                  | 10.11.1-dev, [`60b34fc`](https://github.com/openlayers/openlayers/tree/60b34fc2f6c90eec84e4995dd101f610a657187a)   | BSD-2-Clause   | `src/ol/View.js`, `Kinetic.js`, `interaction/{DragPan,MouseWheelZoom,PinchZoom,PinchRotate,Interaction,defaults}.js`; `test/browser/spec/ol/View.test.js`, `interaction/mousewheelzoom.test.js`                                                                                                          |
| Leaflet                                     | 2.0.0-alpha.1, [`cf6d32f`](https://github.com/Leaflet/Leaflet/tree/cf6d32fca38be70af0be173b970ce997d0a21cd2)       | BSD-2-Clause   | `src/map/Map.js` (`flyTo`), `map/handler/*.js`, `dom/Draggable.js`; `spec/suites/map/handler/*Spec.js`                                                                                                                                                                                                   |
| NASA WebWorldWind                           | 0.11.0, [`5ffe2df`](https://github.com/NASAWorldWind/WebWorldWind/tree/5ffe2dfc54ab4d744fc9e587af9639c9910db228)   | Apache-2.0     | `src/BasicWorldWindowController.js`, `navigate/LookAtNavigator.js`, `gesture/*.js`, `util/GoToAnimator.js`; `test/BasicWorldWindowController.test.js`                                                                                                                                                    |
| NASA WorldWind Java                         | develop, [`2543c23`](https://github.com/NASAWorldWind/WorldWindJava/tree/2543c234349c76f4a290e318b49f071ac156d2a0) | Apache-2.0     | `view/orbit/{BasicOrbitView,OrbitViewInputHandler,OrbitViewCollisionSupport,OrbitViewCenterAnimator,FlyToOrbitViewAnimator}.java`, `view/ViewElevationAnimator.java`, `animation/MoveToDoubleAnimator.java`                                                                                              |
| iTowns                                      | 2.46.0, [`6960a14`](https://github.com/iTowns/itowns/tree/6960a14719a333fca86425e4b7b689733429e8b7)                | MIT / CeCILL-B | `packages/Main/src/Controls/{GlobeControls,StateControl,PlanarControls}.js`, `Utils/CameraUtils.js`; `test/unit/globecontrol.js`, `test/functional/GlobeControls.js`                                                                                                                                     |
| three.js controls                           | r186, [`f480849`](https://github.com/mrdoob/three.js/tree/f480849e035f339b80c58f970fcb5e755abaa549)                | MIT            | `examples/jsm/controls/{OrbitControls,MapControls,TrackballControls,ArcballControls}.js`, `test/e2e/deterministic-injection.js`                                                                                                                                                                          |
| 3DTilesRendererJS (three.js globe controls) | 0.5.3, [`3febfcf`](https://github.com/NASA-AMMOS/3DTilesRendererJS/tree/3febfcff2869771a9152084b80312ae5e244133e)  | Apache-2.0     | `src/three/renderer/controls/{EnvironmentControls,GlobeControls}.js`                                                                                                                                                                                                                                     |

## 3. How each project solves it

### 3.1 CesiumJS

- **Camera:** a free camera (ECEF position plus direction, up and right vectors). Heading, pitch and roll are derived from these vectors, so there is no stored orbit target.
- **Legacy controller** ([`ScreenSpaceCameraController.js`](https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Source/Scene/ScreenSpaceCameraController.js)): `CameraEventAggregator` turns DOM events into "movements" (start and end screen positions). Each frame, `update` dispatches them to `pan3D`, `rotate3D`, `zoom3D`, `tilt3D` and `look3D`, mutating the camera vectors directly.
- **Zoom:** `handleZoom` ([L561](https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Source/Scene/ScreenSpaceCameraController.js#L561)) moves by `zoomFactor × distanceToSurface × pixels/canvasHeight`, capped by `maximumMovementRatio`. Each step is a fraction of the distance, so it behaves logarithmically.
  - The cursor point is picked once per gesture (`_zoomMouseStart`). Several heuristics then choose between zooming along the cursor ray, rotating toward it below 2,000 km, or zooming on the view vector when underground or looking at the horizon.
  - A wheel tick becomes a fixed 7.5°-arc pseudo-movement ([`CameraEventAggregator.js` L152](https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Source/Scene/CameraEventAggregator.js#L152)). Wheel zoom is therefore stepwise.
- **Inertia:** `decay(t, c) = exp(−25(1−c)·t)` of the time since release ([L358](https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Source/Scene/ScreenSpaceCameraController.js#L358)). It scales the last movement and re-applies it _every frame_, so the total coast distance grows with the frame rate.
  - Wall-clock `Date` is used, and inertia is skipped if the press lasted more than 0.4 s.
  - Zoom inertia cancels tilt, spin and translate inertia (`_inertiaDisablers`).
- **Terrain collision:** `adjustHeightForTerrain` ([L2911](https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Source/Scene/ScreenSpaceCameraController.js#L2911)) lifts the eye to `globeHeight + minimumZoomDistance` after the input is applied.
  - To limit jumps while tiles load, it lifts only when the camera moved or the sampled globe height changed by less than 10%.
  - The pick heights are scaled by vertical exaggeration.
- **Touch:** the pinch event carries distance, the angle between the fingers and the midpoint y at once ([`ScreenSpaceEventHandler.js` L786](https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Source/Core/ScreenSpaceEventHandler.js#L786)). `PINCH` is bound to both zoom and tilt, so one two-finger gesture zooms, twists and tilts together, with no threshold that tells them apart.
- **Flights** ([`CameraFlightPath.js`](https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Source/Scene/CameraFlightPath.js)):
  - **Path:** longitude and latitude are interpolated linearly in eased time, and height follows a power-8 hump (`createHeightFunction`, [L77](https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Source/Scene/CameraFlightPath.js#L77)).
  - **Duration:** a distance heuristic capped at 3 s ([L451](https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Source/Scene/CameraFlightPath.js#L451)), with cubic or quintic easing.
  - **Orientation:** heading defaults to 0 and pitch to −90°, so the user's orientation is reset unless the call passes one.
  - **Input:** disabled during the flight (`enableInputs = false`, [L459](https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Source/Scene/CameraFlightPath.js#L459)). Flights are cancelled only through the API.
- **New controller API (2026):** [issue #13473](https://github.com/CesiumGS/cesium/issues/13473), resolved by PR #13604, adds composable `Controller` objects registered on a `ControllerHost`. They collect input in DOM handlers and apply it in `update()` once per frame.
  - The map and elevator pan controllers ([`ScreenSpaceMapCameraController.js` L194](https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Source/Scene/Controllers/ScreenSpaceMapCameraController.js#L194)) keep a pan velocity in px/s and damp it by `exp(−k·dt)` per frame. The decay is time-based.
  - The release velocity is a single-frame delta divided by `dt`, so it is noisy.
  - `HybridScreenSpacePanCameraController` switches pan mode by view angle.

### 3.2 MapLibre GL JS

- **Camera:** target-based. The state holds center, zoom, bearing, pitch and roll, plus the center elevation over terrain.
- **Handler pipeline** ([`handler_manager.ts`](https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/ui/handler_manager.ts)): DOM events go to handlers that return `HandlerResult` deltas (pan, zoom, bearing, pitch, `around`). Results are merged and applied once per render frame (`_updateMapTransform`, [L573](https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/ui/handler_manager.ts#L573)).
  - **Exclusivity:** an active handler blocks the others unless it is on their allow list (`_blockedByActive`, [L409](https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/ui/handler_manager.ts#L409)). `touchPan`, `touchZoom` and `touchRotate` combine; `touchPitch` is exclusive.
  - **Interruption:** any handler change calls `camera.stop(true)` and works from the current transform, so user input interrupts animations without a jump.
- **Anchoring:** the location under `around` before the frame's deltas is re-placed under the pointer after zooming (`setLocationAtPoint`).
  - **Globe pan:** since PR #8154, panning computes the quaternion ("versor") rotation from the previous to the current cursor location ([`vertical_perspective_camera_helper.ts` L163](https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/geo/projection/vertical_perspective_camera_helper.ts#L163)).
    - **Default:** it applies only the swing part, so the bearing stays fixed and a drag over a pole stops the center at the pole.
    - **Opt-out:** `fixedBearing = false` applies the twist too, so the grabbed point tracks the cursor exactly and the bearing drifts.
  - **Globe zoom near the horizon:** blends the exact solution with a heuristic and slows down when the cursor ray misses the planet.
- **Terrain gestures:**
  - The center elevation is _held_ for the whole gesture (`holdElevation`, [camera.ts L1020](https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/ui/camera.ts#L1020)).
  - The drag or zoom is solved on a plane at the elevation of the terrain grabbed on the first frame (`_terrainGestureElevation`, [L681](https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/ui/handler_manager.ts#L681)).
  - When the gesture ends, the center is put back onto the terrain with the camera kept where it is.
  - **Collision:** `_keepCameraAboveTerrain` ([L1122](https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/ui/camera.ts#L1122)) lifts the held elevation during gestures. For animations, it re-solves pitch and zoom on a _copy_ of the transform. The requested state is kept and only the rendered one is corrected, which is effectively chosen vs applied. It checks the eye and nine points on the near plane against the drawn terrain.
- **Wheel** ([`scroll_zoom.ts`](https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/ui/handler/scroll_zoom.ts)):
  - **Classification:** "wheel" vs "trackpad" by magic delta (4.000244140625), by size, and by `timeDelta × value < 200` ([L201](https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/ui/handler/scroll_zoom.ts#L201)). The class picks the zoom rate (1/450 vs 1/100).
  - **Response:** a sigmoid compresses large deltas (at most ×2 scale per frame). Wheel input eases over 200 ms; a new tick re-seeds a bezier whose start slope matches the current speed (`_smoothOutEasing`, [L372](https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/ui/handler/scroll_zoom.ts#L372)). Trackpad input applies directly.
- **Touch** ([`two_fingers_touch.ts`](https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/ui/handler/two_fingers_touch.ts)):
  - Zoom starts after 0.1 zoom levels.
  - Rotation starts after 25 px along the circumference of the smallest finger circle seen, so the angular threshold grows when the fingers are close.
  - Pitch is valid only if the fingers are side by side and both move vertically in the same direction (≥ 2 px, the two starts at most 100 ms apart; `gestureBeginsVertically`, [L343](https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/ui/handler/two_fingers_touch.ts#L343)).
- **Inertia** ([`handler_inertia.ts`](https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/ui/handler_inertia.ts)):
  - **Recording:** results from the last 160 ms are kept. Velocity is measured over a 60 ms window that ends at the _release time_, not at the last movement, so a pause before release means no inertia (fix for #1303).
  - **Output:** an `easeTo` per channel with a bezier ease, `maxSpeed`, `deceleration` and `linearity` (0.3). The coast therefore starts at 30% of the release speed, a deliberate velocity discontinuity.
  - **Timing:** the ease is time-based, so it does not depend on the frame rate.
- **Flights:** `flyTo` ([camera.ts L1425](https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/ui/camera.ts#L1425)) implements van Wijk and Nuij with `curve` ρ = 1.42 and `speed` V = 1.2 screenfuls per second.
  - When the natural arc would exceed `minZoom`, ρ is reduced to `min(ρ, √(2·w_max/u1))`.
  - If `u1 ≈ 0`, it falls back to pure exponential zoom; if nothing changes, to `easeTo`.
  - Bearing and pitch interpolate linearly and are kept unless specified. Reduced motion turns non-essential flights into `easeTo`.
  - **Terrain:** the target elevation is re-targeted mid-flight without a jump (`_updateElevation`).
- **Clock:** all eases are `t = (now − start)/duration`. `now()` can be frozen for deterministic tests (`time_control.ts`).

### 3.3 OpenLayers

- **View model:** a 2D map view (center, resolution, rotation) with _target_ values (`targetCenter_`, `targetResolution_`).
  - During an interaction (`beginInteraction`/`endInteraction`), constraints are soft. On release, `resolveConstraints` animates back inside the extent and resolution limits ([`View.js` L1844](https://github.com/openlayers/openlayers/blob/60b34fc2f6c90eec84e4995dd101f610a657187a/src/ol/View.js#L1844)), so the map eases against its edges instead of bouncing.
- **Animations** (`animateInternal`/`updateAnimations_`, [L626](https://github.com/openlayers/openlayers/blob/60b34fc2f6c90eec84e4995dd101f610a657187a/src/ol/View.js#L626), [L769](https://github.com/openlayers/openlayers/blob/60b34fc2f6c90eec84e4995dd101f610a657187a/src/ol/View.js#L769)):
  - **Timing:** progress is `Date.now() − start` over the duration, with an easing function.
  - **Interpolation:** center and **resolution** are interpolated _linearly_, not in log space, so a large zoom animation spends most of its time at the coarse end. An `anchor` keeps a point fixed while the resolution animates.
  - **Flights:** there is no `flyTo`. The examples chain zoom-out and zoom-in animations in parallel with a center animation.
  - **Interruption:** every interaction start and wheel event calls `cancelAnimations()`.
- **Kinetic panning** ([`Kinetic.js`](https://github.com/openlayers/openlayers/blob/60b34fc2f6c90eec84e4995dd101f610a657187a/src/ol/Kinetic.js)): records (x, y, t) samples and measures velocity over the last 100 ms.
  - It refuses if the last sample is older than the delay or the span is shorter than one 60 Hz frame.
  - Distance is `(minVelocity − v0)/decay`, with defaults `Kinetic(−0.005, 0.05, 100)`. `DragPan` then animates to that distance with a 500 ms `easeOut`.
- **Wheel** ([`MouseWheelZoom.js`](https://github.com/openlayers/openlayers/blob/60b34fc2f6c90eec84e4995dd101f610a657187a/src/ol/interaction/MouseWheelZoom.js)):
  - **Mode:** decided by `|delta| < 4` at the start of a burst.
  - **Trackpad mode:** continuous `adjustZoom` with a 3× multiplier for pinch.
  - **Pinch detection:** pinch is recognized as `wheelEvent.ctrlKey && !mapBrowserEvent.ctrlKey`, meaning a synthesized ctrl rather than a pressed key ([L211](https://github.com/openlayers/openlayers/blob/60b34fc2f6c90eec84e4995dd101f610a657187a/src/ol/interaction/MouseWheelZoom.js#L211)).
  - **Wheel mode:** accumulates for 80 ms, then animates ±1 level over 250 ms.
- **Touch:** `PinchRotate` starts only after 0.3 rad. `PinchZoom` has no threshold. Interactions are independent and stop the event chain only by return value.

### 3.4 Leaflet

- **Model:** a 2D map pane moved by CSS transforms. Zoom animations are CSS transitions between integer or fractional zooms.
- **Wheel:** deltas are debounced for 40 ms (`wheelDebounceTime`), then a single animated zoom runs.
- **Inertia** ([`DragHandler.js`](https://github.com/Leaflet/Leaflet/blob/cf6d32fca38be70af0be173b970ce997d0a21cd2/src/map/handler/DragHandler.js)): keeps positions from the last 50 ms ([L94](https://github.com/Leaflet/Leaflet/blob/cf6d32fca38be70af0be173b970ce997d0a21cd2/src/map/handler/DragHandler.js#L94)). Speed is capped (`inertiaMaxSpeed`) and decelerated (`inertiaDeceleration`, `easeLinearity`) into a `panBy` animation. MapLibre's inertia descends from this design.
- **Flights:** `flyTo` ([`Map.js` L554](https://github.com/Leaflet/Leaflet/blob/cf6d32fca38be70af0be173b970ce997d0a21cd2/src/map/Map.js#L554)) is a direct van Wijk and Nuij implementation.
  - **Parameters:** ρ = 1.42, duration `0.8·S` seconds, and an `easeOut(t) = 1 − (1−t)^1.5` applied to _s_, so it starts fast and ends smoothly.
  - **Guard:** clamps `log(0)` to −18 to avoid an infinite loop on degenerate paths.
  - **Reduced motion:** turns `flyTo` into `setView`.
  - **Rotation and tilt:** none.

### 3.5 NASA WorldWind (Web and Java)

- **WebWorldWind:** a `LookAtNavigator` (look-at location, range, heading, tilt, roll), essentially the target-based model.
  - **Recognizers:** `BasicWorldWindowController` wires UIKit-style gesture recognizers. Pan, pinch and rotation recognize simultaneously, and all three _require the tilt recognizer to fail_ ([L107–116](https://github.com/NASAWorldWind/WebWorldWind/blob/5ffe2dfc54ab4d744fc9e587af9639c9910db228/src/BasicWorldWindowController.js#L107)). Tilt fails if the fingers are more than 250 px apart or diverge by more than 50 px.
  - **Pan:** moves the look-at location by meters-per-pixel at `range` over the ellipsoid, not by keeping a grabbed point under the cursor ([L209](https://github.com/NASAWorldWind/WebWorldWind/blob/5ffe2dfc54ab4d744fc9e587af9639c9910db228/src/BasicWorldWindowController.js#L209)).
  - **Wheel:** scales `range` by `1 + delta/1000` about the look-at point, so it is not cursor-anchored.
  - **Inertia and collision:** none.
  - **Flights:** `GoToAnimator` runs on `setTimeout` (20 ms) with constant range and pan velocities, climbing to a peak range equal to the start–end distance ([`GoToAnimator.js`](https://github.com/NASAWorldWind/WebWorldWind/blob/5ffe2dfc54ab4d744fc9e587af9639c9910db228/src/util/GoToAnimator.js)).
- **WorldWind Java:**
  - **Input smoothing:** input sets targets that per-frame "move-to" animators approach with a fixed interpolant `1 − smoothing` per frame ([`OrbitViewCenterAnimator.java` L63](https://github.com/NASAWorldWind/WorldWindJava/blob/2543c234349c76f4a290e318b49f071ac156d2a0/src/gov/nasa/worldwind/view/orbit/OrbitViewCenterAnimator.java#L63)). This is classic frame-rate-dependent smoothing.
  - **Collision:** `resolveCollisionsWithPitch` and `resolveCollisionsWithCenterPosition` ([`BasicOrbitView.java` L294](https://github.com/NASAWorldWind/WorldWindJava/blob/2543c234349c76f4a290e318b49f071ac156d2a0/src/gov/nasa/worldwind/view/orbit/BasicOrbitView.java#L294)) overwrite the pitch or the center elevation permanently when the eye would be below terrain, so the user's tilt is lost.
  - **Flights:** fly-to uses a mid-zoom elevation hump (`computeMidZoom`).

### 3.6 iTowns

- **Model:** `GlobeControls` keeps a camera target (an `Object3D` rig on the globe) and spherical coordinates around it.
- **States and anchoring:** `StateControl` maps mouse buttons, keys and double clicks to states (`MOVE_GLOBE`, `ORBIT`, `DOLLY`, `PAN`, `PANORAMIC`, `TRAVEL_IN`/`TRAVEL_OUT`). Picking uses the depth buffer (`getPickingPositionFromDepth`).
- **Damping:** per-frame multiplicative (`sphericalDelta *= 1 − 0.25`, `slerp(…, 0.2·dampingMoveFactor)`). Inertia on `MOVE_GLOBE` is launched only if the release came within 50 ms of the last move ([`GlobeControls.js` L666](https://github.com/iTowns/itowns/blob/6960a14719a333fca86425e4b7b689733429e8b7/packages/Main/src/Controls/GlobeControls.js#L666)).
- **Collision** (`update`, [L415](https://github.com/iTowns/itowns/blob/6960a14719a333fca86425e4b7b689733429e8b7/packages/Main/src/Controls/GlobeControls.js#L415)):
  - It traverses tiles above level 10 for the smallest distance between a sphere around the camera (60 m) and the top face of each tile's oriented box.
  - In orbit, tilt is slowed in a "slowdown zone" and steered back in a "constraint zone". The camera is pushed up if it is underground.
- **Travel:** `CameraUtils.animateCameraToLookAtTarget` ([L219](https://github.com/iTowns/itowns/blob/6960a14719a333fca86425e4b7b689733429e8b7/packages/Main/src/Utils/CameraUtils.js#L219)) tweens rig parameters with tween.js (`Quartic.InOut`, 2.5 s default). This is a second animation system next to the controls' `AnimationPlayer`.

### 3.7 three.js controls (and 3DTilesRendererJS)

- **`OrbitControls`/`MapControls`:**
  - **State:** a spherical offset around `target`.
  - **Damping:** applies a fraction of the pending delta per `update()` and decays it by `(1 − dampingFactor)` per call ([L799](https://github.com/mrdoob/three.js/blob/f480849e035f339b80c58f970fcb5e755abaa549/examples/jsm/controls/OrbitControls.js#L799)), which is frame-rate dependent. Only `autoRotate` takes `deltaTime` (since #26471).
  - **Zoom to cursor:** `zoomToCursor` dollies along the cursor ray. `MapControls` pans on the ground plane (`screenSpacePanning = false`) and needs a target on that plane.
- **Other controls:**
  - **`TrackballControls`:** per-frame `dynamicDampingFactor`.
  - **`ArcballControls`:** rotation inertia is closed-form constant deceleration, `θ(t) = w0·t − ½·α·t²`, evaluated at absolute elapsed time ([L2137](https://github.com/mrdoob/three.js/blob/f480849e035f339b80c58f970fcb5e755abaa549/examples/jsm/controls/ArcballControls.js#L2137)). It is exactly frame-rate independent.
- **3DTilesRendererJS `EnvironmentControls`/`GlobeControls`:**
  - **Picking:** pivot and zoom point come from BVH raycasts against the loaded tiles, with a fallback plane.
  - **Damping:** time-based half-life, `2^(−dt/dampingFactor)` ([`EnvironmentControls.js` L1172](https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/3febfcff2869771a9152084b80312ae5e244133e/src/three/renderer/controls/EnvironmentControls.js#L1172)), with `dt` capped at 64 ms.
  - **Collision:** the camera is pushed up to `cameraRadius` above a downward raycast hit.

## 4. Known failure modes from issue trackers

| Issue                                                                               | Symptom                                                                            | Root cause                                                                               | Lesson                                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [cesium#5999](https://github.com/CesiumGS/cesium/issues/5999)                       | Camera jumps hundreds of meters up once terrain finishes loading                   | Terrain adjustment suspended on `setView`, then a post-hoc clamp to newly loaded heights | Collide continuously against the _displayed_ surface; never teleport the camera when data arrives                                                                                   |
| [cesium#4537](https://github.com/CesiumGS/cesium/issues/4537) (open)                | Mouse-wheel zoom is jumpy; right-drag zoom is smooth                               | Wheel inertia was removed, so each tick moves the camera in one step                     | Notch input must be smoothed over time                                                                                                                                              |
| [cesium#9929](https://github.com/CesiumGS/cesium/issues/9929) (open)                | Pinch zoom fails on Android and some iPhones                                       | The two fingers' moves arrive as separate events; the logic assumes paired updates       | Compute two-finger state once per frame from the latest position of every pointer                                                                                                   |
| [cesium#11288](https://github.com/CesiumGS/cesium/issues/11288)                     | Camera goes under 3D Tiles terrain                                                 | Collision assumed globe terrain only                                                     | Collision queries a surface-height interface that every surface layer can feed                                                                                                      |
| [maplibre#2709](https://github.com/maplibre/maplibre-gl-js/issues/2709)             | After `flyTo` interrupts a scroll zoom, the next scroll snaps back to the old zoom | Handler kept a hidden `_targetZoom` that reset did not clear                             | No hidden targets: every input starts from the applied camera                                                                                                                       |
| [maplibre#4233](https://github.com/maplibre/maplibre-gl-js/issues/4233)             | Inertial drag over terrain jumps to another place                                  | Terrain re-solve at gesture end conflicted with the kept transform                       | Re-seating the target onto terrain must leave the eye unchanged                                                                                                                     |
| [maplibre#7989](https://github.com/maplibre/maplibre-gl-js/issues/7989)             | Camera jumps between `dragend` and `moveend` when DEM loads mid-drag               | Center elevation changed during the gesture                                              | Freeze anchor and target elevation for the gesture; see also PR [#8548](https://github.com/maplibre/maplibre-gl-js/pull/8548) (DEM landing during pitch inertia "threw the camera") |
| [maplibre#1024](https://github.com/maplibre/maplibre-gl-js/issues/1024)             | Zoom center not under the cursor with terrain                                      | Anchor solve ignored terrain                                                             | Anchor on the grabbed terrain point, solved at its height                                                                                                                           |
| [maplibre#5296](https://github.com/maplibre/maplibre-gl-js/issues/5296)             | Globe pan reverses and stalls near the poles                                       | Bearing-preserving solve has no solution near the poles                                  | Fall back to a free rotation where the constrained solve is ill-conditioned                                                                                                         |
| [maplibre#6111](https://github.com/maplibre/maplibre-gl-js/issues/6111)             | Flick on a pitched map pans the wrong way                                          | Inertia displacement crossed the horizon                                                 | Clamp inertia so the anchor never leaves the visible surface                                                                                                                        |
| [maplibre#1303](https://github.com/maplibre/maplibre-gl-js/issues/1303)             | Map glides after a drag that paused before release                                 | Velocity measured over a 160 ms buffer ending at the last move                           | Measure velocity up to the release time                                                                                                                                             |
| [leaflet#5652](https://github.com/Leaflet/Leaflet/issues/5652)                      | Same: inertia after a pause                                                        | Same                                                                                     | Same; also [itowns#353](https://github.com/iTowns/itowns/issues/353) (samples too sparse)                                                                                           |
| [maplibre#8809](https://github.com/maplibre/maplibre-gl-js/issues/8809) (open)      | After a pinch, lifting one finger leaves the other unable to pan                   | Inertia completion resets the touch handlers despite the remaining contact               | Inertia must never reset live pointers; finger-count changes re-baseline the gesture                                                                                                |
| [openlayers#6485](https://github.com/openlayers/openlayers/issues/6485)             | Touch zoom jumps when the second finger lands later                                | Gesture reference not re-captured on pointer change                                      | Re-baseline (anchor, distance, angle) on every pointer add or remove                                                                                                                |
| [openlayers#14684](https://github.com/openlayers/openlayers/issues/14684) (open)    | Pinch also drags a selected feature                                                | Independent interactions, drag propagation never stopped                                 | One arbiter decides which recognizers may run together                                                                                                                              |
| [maplibre#5637](https://github.com/maplibre/maplibre-gl-js/issues/5637)             | Accidental rotation while pinch-zooming                                            | Rotate and zoom share the gesture                                                        | Rotation gated by a distance-scaled threshold                                                                                                                                       |
| [maplibre#5367](https://github.com/maplibre/maplibre-gl-js/issues/5367) (open)      | Wheel zoom sometimes very fast or choppy (free-spinning wheels)                    | Trackpad/wheel heuristic flips the zoom _rate_ mid-gesture                               | Never let device classification change the zoom amount                                                                                                                              |
| [leaflet#4410](https://github.com/Leaflet/Leaflet/issues/4410) (open)               | Jumpy zoom with Magic Mouse                                                        | macOS momentum events fed into discrete zoom steps                                       | Treat wheel as a continuous signal                                                                                                                                                  |
| [openlayers#15423](https://github.com/openlayers/openlayers/issues/15423)           | Trackpad zoom too fast (snapped) or pinch too slow                                 | Integer snapping; pinch emits smaller deltas                                             | Separate pinch gain; no snapping by default                                                                                                                                         |
| [three.js#22525](https://github.com/mrdoob/three.js/issues/22525) (open)            | Trackpad gestures scroll or zoom the page                                          | Pinch arrives as ctrl+wheel; Safari uses non-standard gesture events                     | Handle ctrl-wheel and Safari `gesture*` with `preventDefault`                                                                                                                       |
| [three.js#27110](https://github.com/mrdoob/three.js/issues/27110)                   | `zoomToCursor` misbehaves at low angles                                            | Ray misses the plane; the stale target is kept                                           | Explicit fallback when the cursor ray misses the surface                                                                                                                            |
| [babylon.js#12820](https://github.com/BabylonJS/Babylon.js/issues/12820)            | Inertia far stronger on 120–360 Hz screens                                         | Decay applied per rendered frame                                                         | Evaluate inertia in closed form over elapsed time; see also [three.js#26471](https://github.com/mrdoob/three.js/issues/26471)                                                       |
| [openlayers#14426](https://github.com/openlayers/openlayers/issues/14426) (open)    | Quick pans leave the center `NaN`                                                  | Zero decay divides by zero                                                               | Validate tuning constants at the boundary                                                                                                                                           |
| [maplibre#1542](https://github.com/maplibre/maplibre-gl-js/issues/1542) (open)      | Camera can move inside 3D terrain                                                  | Elevation lookup at fractional zoom misses the cache and returns 0                       | The collision query must read exactly the tiles being drawn                                                                                                                         |
| [webworldwind#787](https://github.com/NASAWorldWind/WebWorldWind/issues/787) (open) | Orbit pivot below the surface; the street flies out of view                        | Pivot on the ellipsoid, not the terrain                                                  | Pivot on the displayed terrain point                                                                                                                                                |
| [webworldwind#432](https://github.com/NASAWorldWind/WebWorldWind/issues/432) (open) | Drag moves the globe too far at low altitude over high terrain                     | Pan scale from range over the ellipsoid                                                  | Grab-anchor at the terrain height                                                                                                                                                   |
| [leaflet#9438](https://github.com/Leaflet/Leaflet/issues/9438) (open)               | `flyTo` between nearby points misplaces layers                                     | Degenerate path (u1 ≈ 0)                                                                 | Short flights fall back to `easeTo`                                                                                                                                                 |
| [itowns#1972](https://github.com/iTowns/itowns/issues/1972) (open)                  | Camera animation during controls damping glitches                                  | Two unsynchronized animation systems                                                     | One owner of camera animation                                                                                                                                                       |

## 5. How they test camera behavior

- **CesiumJS:** Jasmine specs in real browsers. `ScreenSpaceCameraControllerSpec` (73 cases) fires pointer and wheel events on a canvas with `DomEventSimulator`, calls `controller.update()` by hand against a `MockScene`, and asserts the direction of motion. `CameraFlightPathSpec` samples `update({time})` step by step and asserts endpoints and monotonic longitude across the antimeridian. No specs exist for the new `Controllers` at this commit.
- **MapLibre:**
  - **Unit:** Vitest with `simulate.*` events and mocked `now()`. `handler_inertia.test.ts` covers low frame rates ("pans on at frame rates too low…") and releases without movement. `camera.test.ts` has 321 cases, including flight arcs vs `minZoom`, interrupted motions and inertia not crossing the horizon.
  - **Browser:** Puppeteer tests drag, double-click and the scroll-after-flyTo regression (#2709).
  - **Render:** ~1,700 tests compare static views; the end-to-end benchmarks time the public API in headless Chrome.
- **OpenLayers:** browser specs stub `requestAnimationFrame` to drive `View.animate` and check wheel delta modes and the pinch-vs-ctrl multiplier. About 235 rendering tests cover static output.
- **Leaflet:** Mocha in real browsers with `prosthetic-hand`, scripted multi-finger pointer timelines in `fastframe` mode, for drag, pinch, box zoom and wheel.
- **WebWorldWind:** one unit test of the 2D drag math. **iTowns:** unit tests on a mocked view, plus Puppeteer functional tests that drive real mouse drags with damping _disabled_ and assert coarse outcomes (≥ 25° moved). **three.js:** no controls tests; end-to-end screenshots of examples with `Date.now`, `performance.now`, `Math.random` and `requestAnimationFrame` made deterministic.
- **Gap shared by all:** none tests frame-rate independence across refresh rates, frame-to-frame continuity at interruptions, or multi-touch end to end on WebKit.

## 6. Literature

- **van Wijk and Nuij, Smooth and Efficient Zooming and Panning (InfoVis 2003).**
  - **Model:** the view is a window of width _w_ at position _u_. The optimal pan-and-zoom path minimizes a perceptual length in which ρ trades zooming out against panning.
  - **Closed form:**
    - `w(s) = w0·cosh(r0)/cosh(ρs + r0)`
    - `u(s) = (w0/ρ²)·(cosh(r0)·tanh(ρs + r0) − sinh(r0))`
    - `r_i = ln(−b_i + √(b_i² + 1))`, with `b_0,1 = (w1² − w0² ± ρ⁴u1²)/(2·w_{0,1}·ρ²·u1)`
    - Total length `S = (r1 − r0)/ρ`. When `u1 = 0`: `w = w0·e^{±ρs}` and `S = |ln(w1/w0)|/ρ`.
  - **Speed:** moving at constant `ds/dt = V` gives perceptually uniform speed, so `duration = S/V`.
  - **Use in practice:** d3, Leaflet and MapLibre use ρ ≈ √2 (1.42). MapLibre adds V = 1.2 and ρ capping. The derivation is planar; on a globe, _u_ becomes the geodesic distance and _w_ the visible ground width, valid until the whole globe is in view.
- **Reach and North, Smooth, Efficient, and Interruptible Zooming and Panning (IEEE TVCG 25(2), 2019; arXiv 1801.09358):** van Wijk–Nuij paths are not smooth at the endpoints or when a new target interrupts a running transition. They propose dynamical systems in hyperbolic space that keep velocity continuous under retargeting. This is the reference if velocity-matched easing (§8) proves insufficient.
- **Cozzi and Ring, 3D Engine Design for Virtual Globes (2011):** ellipsoid geometry (geodetic surface normals, ray–ellipsoid intersection) behind every cursor anchor and pivot.
- **Karney, Algorithms for Geodesics (2013):** the geodesic used as the flight's ground track and for "short way across the antimeridian".

## 7. Comparison of approaches

| Concern              | Options seen                                                                                                                                                                                                                                                              | Failure modes                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Camera state         | Free eye + orientation (Cesium, three.js `Trackball`); target + range + heading + tilt (MapLibre, WorldWind, iTowns, `OrbitControls`)                                                                                                                                     | Free camera: every operation re-picks a target, and heading and tilt are derived, so "keep the user's tilt" has no home. Target-based models express orbit, persistence and clamping directly.                             |
| When input applies   | Per DOM event (Cesium legacy, OpenLayers, Leaflet); per frame from aggregated input (MapLibre, Cesium Controllers, WorldWind recognizers)                                                                                                                                 | Per-event updates break on uneven event delivery (cesium#9929) and do work faster than the display can show it                                                                                                             |
| Anchoring            | Per-projection hand-written solves (MapLibre helpers, Cesium 2D/CV/3D branches); meters-per-pixel approximation (WebWorldWind)                                                                                                                                            | Special cases multiply (horizon, poles, terrain); approximations drift off the grabbed point (webworldwind#432, maplibre#1024)                                                                                             |
| Inertia              | Per-frame multiplicative (Cesium legacy, iTowns, `OrbitControls`, `Trackball`, WorldWind Java); time-based eased animation (MapLibre, Leaflet, OpenLayers); closed form in elapsed time (`ArcballControls`); exponential per `dt` (Cesium Controllers, 3DTilesRendererJS) | Per-frame decay depends on refresh rate (babylon.js#12820). Velocity windows ending at the last move cause post-pause glides (maplibre#1303). Integrating `v·dt` with Euler steps leaves a small dependence on frame rate. |
| Wheel                | Fixed steps (Cesium); debounce plus animate (Leaflet, OpenLayers wheel mode); wheel/trackpad classification choosing the rate (MapLibre, OpenLayers)                                                                                                                      | Steps feel jumpy (cesium#4537); misclassification changes speed (maplibre#5367, leaflet#4410)                                                                                                                              |
| Touch disambiguation | Everything at once (Cesium); thresholds plus exclusive pitch (MapLibre); recognizer graph with require-to-fail (WorldWind); independent interactions (OpenLayers)                                                                                                         | Accidental rotate or tilt; double handling (openlayers#14684); no re-baseline on finger change (openlayers#6485)                                                                                                           |
| Flights              | Power-curve height hump (Cesium); constant velocities (WebWorldWind); eased lerp of rig (iTowns); van Wijk–Nuij (Leaflet, MapLibre)                                                                                                                                       | Ad-hoc humps give uneven perceived speed and a 3 s cap; linear resolution interpolation (OpenLayers) slows at the coarse end; degenerate van Wijk paths need fallbacks (leaflet#9438)                                      |
| Terrain collision    | Post-hoc eye lift (Cesium, 3DTilesRendererJS); permanent pitch or center rewrite (WorldWind Java); slowdown zones (iTowns); applied-only correction with held elevation (MapLibre)                                                                                        | Jumps when tiles load (cesium#5999); lost user tilt; collision reading the wrong tiles (maplibre#1542)                                                                                                                     |
| Interruption         | Inputs disabled during flights (Cesium); stop and start from current state (MapLibre, OpenLayers); two animation systems (iTowns)                                                                                                                                         | Hidden targets resurface (maplibre#2709); unsynchronized animators (itowns#1972)                                                                                                                                           |

Where the backend matters (WebGPU vs WebGL2):

- **Anchor picking:** a pan or zoom anchor must exist in the first frame of a gesture.
  - **WebGPU:** depth or id readback is asynchronous (`mapAsync`, at least one frame late).
  - **WebGL2:** `readPixels` is synchronous but stalls the pipeline. Depth-based picking (iTowns) also loses precision far away.
  - **Consequence:** CPU ray casting against the drawn terrain tiles (float64, bounding-volume pruned) is the only immediate, backend-independent option. GPU picking stays for features (M10).
- **Latency:** input-to-photon latency can differ between backends and browsers (presentation queueing), so it is measured per backend.
- **OffscreenCanvas:** if rendering moves to a worker (M2 evaluation), only the main thread receives input. A per-frame snapshot of coalesced input keeps the recognizers independent of where the frame is computed.

## 8. Chosen approach for VibeGlobeEngine

Full decision, options and consequences: [ADR 0009](../adr/0009-camera-and-input.md). Each choice and the reason for it:

1. **Geodetic target-based camera (core, M2).**
   - **State:** target (longitude, latitude, height) plus `range`, `heading`, `tilt` and `roll` (0 for navigation); the eye is derived in float64 ECEF. Zoom is a log2 function of range (ground scale, the ground zoom of [ADR 0008](../adr/0008-globe-to-flat-morph.md)), and all zoom input and animation works in zoom units. Pans hold range, so they never move the morph curves.
   - **Why:** orbiting, persistent heading and tilt (F157, F158) and clamping are direct operations on this state. Flights and the morph never have to recover a target, as a free camera must (Cesium).
2. **Chosen vs applied for tilt, heading and range.**
   - **Rule:** constraints (sky limit, max tilt, min/max zoom, bounds, terrain clearance) write only applied values. Applied relaxes toward chosen with a time constant. A gesture starts from the applied values.
   - **Why:** no clamp ever overwrites the user's choice, unlike WorldWind Java. There are no hidden targets to resurface (maplibre#2709). Range is included so a collision near a mountain never leaves a permanent zoom change.
3. **Per-frame input coalescing and one arbiter (controls).**
   - **Capture:** Pointer Events with pointer capture, `touch-action: none`, a non-passive `wheel` listener, Safari `gesture*` events and keyboard input only record into an input state.
   - **Recognizers:** run once per frame (frame step 2). Two-finger input starts undecided, then becomes either exclusive tilt (MapLibre's side-by-side vertical test) or combined pan, zoom and rotate, with thresholds on zoom and rotation. A pointer add or remove re-baselines the gesture with zero delta.
   - **Wheel:** one continuous mapping from pixel delta to zoom. Device class only picks the smoothing time constant and the pinch gain.
   - **Why:** this handles uneven event delivery (cesium#9929), double handling (openlayers#14684), finger changes (openlayers#6485, maplibre#8809), accidental rotation (maplibre#5637) and classification errors (maplibre#5367, leaflet#4410).
4. **One anchor-constraint solver (core).**
   - **Rule:** pan, zoom-at-point, orbit and the morph anchor are each "point A, at its frozen height, stays at pixel p", plus a change of range, heading or tilt. A 2×2 Gauss–Newton solves the target in float64 through the renderer's own projection, with the heading held. This is the same Newton solve ADR 0008 uses for the morph anchor.
   - **Fallbacks:** free rotation near the poles (the heading change is user-caused and written to chosen); a horizon blend toward the screen center.
   - **Why:** a single code path is exact in the globe, morph, flat, tilted and terrain cases, instead of per-projection special cases (maplibre#1024, maplibre#5296, webworldwind#432 and #787).
5. **Closed-form, time-based motion.**
   - **Inertia:** velocity from pointer timestamps over 80 ms ending at release. Per-channel `x(t) = v0·τ·(1 − e^{−t/τ})` evaluated at absolute elapsed time, clamped at the horizon. No wheel inertia.
   - **Animations:** pure functions of the clamped engine clock. `flyTo` is van Wijk–Nuij on the geodesic (ρ = 1.42, V = 1.2 to start, ρ capped at the full-globe view, ease-in-out on _s_, degenerate paths fall back). Tilt and heading are kept unless the call sets them, and the destination height is re-targeted without a jump.
   - **Interruption:** user input continues from the applied state. A programmatic retarget matches the current speed.
   - **Why:** the same trajectory at every refresh rate (babylon.js#12820), no post-pause glide (maplibre#1303, leaflet#5652), continuous speed at release, and perceptually uniform flights.
6. **Terrain collision against the displayed surface (M4, M6).**
   - **Rule:** the eye and near-plane corners clear the geomorphed surface through a `SurfaceHeightProvider`, correcting applied tilt first, then applied range. Target and anchor heights are frozen during gestures, and re-seating the target afterwards never moves the eye.
   - **Why:** this prevents jumps when tiles arrive (cesium#5999, maplibre#7989, maplibre#4233) and collision against tiles that are not drawn (maplibre#1542). 3D Tiles feed the same interface in M13 (cesium#11288).

**To measure in the milestones that build it:**

- **Anchoring (M2):** anchor invariance ≤ 0.01 px. Property tests over random states, including poles, antimeridian, tilt and terrain.
- **Collision (M4):** clearance holds in every frame of the collision scenario with delayed fine tiles. No frame-to-frame eye jump above the scenario bound.
- **Chosen vs applied (M5):** the sky-limit formula and the relaxation τ.
- **Navigation (M6):**
  - **Frame-rate independence:** the same scripted input at 30, 60, 120 and 144 Hz and with stalls gives identical trajectories (relative error ≤ 1e-9).
  - **Interruption:** zero discontinuity at interruption frames.
  - **Tuning:** inertia τ and gains, wheel rates, and touch thresholds, side by side with Google Maps and Google Earth on the reference devices.
  - **Cost:** controls CPU ≤ 0.2 ms per frame with zero allocations, and a CPU ray-cast pick ≤ 0.1 ms.
  - **Latency:** input-to-frame latency on both backends.

## 9. Open questions

1. **Safari:** does current Safari still need `gesturestart`/`gesturechange` for trackpad pinch, or does it now send ctrl-wheel? To verify on a device in M6.
2. **Multi-touch automation:** Playwright has no multi-touch API. Chromium can use CDP `Input.dispatchTouchEvent`; WebKit multi-touch needs real tablets. The procedure is to be documented in M6.
3. **Heading near the poles:** heading changes when the globe-phase drag falls back to free rotation near the poles. The alternative is MapLibre's default: hold the bearing and stop the center at the pole, which gives up exact anchoring (F175). The owner should confirm the choice against "no automatic north-up" (the change is user-caused).
4. **Interruptible flights:** whether velocity-matched easing is enough for retargeted flights, or Reach and North's interruptible paths are needed (decide in M6 from frame-difference measurements).
5. **Chosen range and zoom drift:** extending chosen vs applied to range (zoom) goes beyond architecture §5, which names tilt and heading. Pans hold range, which is ground scale (the ground zoom of [ADR 0008](../adr/0008-globe-to-flat-morph.md)), so the public Mercator zoom drifts about 0.023 per 100 km at 45° in the flat phase. The owner must confirm this, as ADR 0008 notes.
