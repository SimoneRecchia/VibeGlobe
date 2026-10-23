# 0036. Camera movements: flights, eases, outcomes and movement events

- Status: Accepted (decided by agent; owner may revisit)
- Date: 2026-10-22
- Milestone: M6 (engine side; the input gestures are another session's, `packages/controls`)

## Context

M6 asks for `flyTo` along van Wijk and Nuij's path (F195, F196), `easeTo` (F198), `jumpTo` with movement events
(F197), tours (F199), a promise per movement that settles as completed, interrupted or cancelled and never hangs, with
`movestart`, `move` and `moveend` events carrying their cause (F200), the chosen tilt, heading and view mode kept
unless a call gives them (F201), interruption by any user input (F202) and frame-rate independence (F203).
`docs/plan/api.md` sketched `CameraAnimation extends Promise<void>` rejecting with an `AbortError` when interrupted.

## Decision

1. **Outcomes resolve, they do not reject.** A movement returns `CameraMovement`, a `Promise<MoveOutcome>` with
   `cancel()`, where `MoveOutcome` is `'completed' | 'interrupted' | 'cancelled'`: interrupted by user input or a newer
   movement, cancelled by `cancel()` or the call's `AbortSignal`. A user who drags during a flight is normal use; a
   rejection would surface as an unhandled rejection in every application that does not catch it. Only invalid
   arguments reject, with a `GlobeError` (`invalid-option`, `invalid-coordinate`), before the camera moves. This
   amends the sketch in `docs/plan/api.md`.
2. **One movement at a time, driven by the engine clock.** A `CameraAnimator` (`packages/core/src/camera`) computes the
   pose as a function of engine time alone, so the trajectory is the same at every frame rate and after stalls (F203).
   `easeTo` moves the center along the great circle, the range geometrically, the heading along the shorter arc and the
   tilt, on one ease-in-out curve; `flyTo` moves the center and range along van Wijk and Nuij's path (ρ = 1.42 by
   default) with an automatic duration proportional to the path length (1.2 units per second, 0.4 to 8 s) unless
   given. The frame loop steps the animator before the selection, and the view state's zoom curves then derive morph,
   relief and the Auto tilt from the animated range, so long flights pass through the phases on their own (F196).
3. **Tilt, heading and mode (F201).** A target without a tilt keeps the chosen tilt and the view mode; a target with
   one chooses it (manual mode, as `jumpTo` does, ADR 0034) and the animation moves the chosen tilt to it. A target
   without a heading keeps the heading.
4. **Events.** `movestart` when a movement begins, `move` at most once per drawn frame while the camera moves, and
   `moveend` with the outcome; each carries its cause: `'api'` (movement calls), `'user'` (navigation intents from
   controls) or `'inertia'` (reserved for the controls' inertia). `jumpTo` emits all three in one frame and returns
   `'completed'`.
5. **Interruption (F202).** Any navigation intent (`grab`, `dragTo`, `zoomAt` and the other intents the controls use)
   and any new movement interrupt the running one, which settles as `'interrupted'`; the camera keeps the pose of the
   last drawn frame, so the takeover starts from where the view is.

## Consequences

- Movements are cheap to fire and forget: `await globe.flyTo(…)` never throws because the user touched the map.
- The same animator serves tours, `fitBounds`, orbit and home flights (F192–F194, F199), which compute a target and
  hand it over.
- Reduced motion (F214) replaces a flight by a short ease when the system setting asks for it.

## Addendum: reduced motion (F214)

The renderer's host reports the system's reduced-motion setting (`RenderHost.observeReducedMotion`, from `prefers-reduced-motion`), followed at runtime and exposed as `Globe.reducedMotion`. While it is set, a flight (`flyTo`, `fitBounds`, `resetToGlobe`, `goHome` and a tour's flight legs) does not traverse its path: the view fades out, the camera jumps to the target at the midpoint and the view fades back in, over 300 ms of engine time (`RenderHost.setOpacity` sets the canvas opacity). Eases stay as they are: they are short by design. Input inertia is the controls package's, which reads `Globe.reducedMotion` (a hook request in `docs/parallel-tracks.md`).
