# 0195. A moving camera keeps the detail already on the GPU

- Status: Accepted
- Date: 2026-11-05
- Milestone: M8 and M13 (F713, F714, KB-345; amends ADR 0006 on motion-aware detail and ADR 0122 on adaptive quality)

## Context

The owner's report of 2026-11-05, from an application's satellite view of the Alps at about zoom 8: while the camera
pans or zooms, the whole map drops to a very blurry level, although the sharp tiles were on screen a moment before; it
turns sharp again when the camera stops. The owner wants the view always sharp when its tiles are there.

Two mechanisms blurred a moving view:

1. **Motion-aware detail (F287, F288, F301; ADR 0006 §2).** A fast camera multiplied the selection's texel threshold by
   up to 4 (8 on a slow link), so the surface was selected up to two levels coarser and each tile drew its imagery at
   that level: the finer tiles already resident were dropped as the camera started, and came back when it stopped. In
   a chain whose finer source starts at level 9 the moving view switched to the coarser source altogether.
2. **Adaptive quality's rest (F688; ADR 0122).** Once slow frames lowered the governor's level, the camera's first
   movement after every rest brought it back at once. The level rises again only after 3 s of frames under 0.75 × the
   target (never on a 60 Hz screen) or 12 s of frames at the target while moving, which short pans never give: a level
   lowered once, by a slow start-up for instance, lowered the resolution of every later movement for good, however
   fast its frames were.

## Options considered

1. **Keep coarsening the selection, and refine it where finer imagery is resident.** The selection would have to look
   up the imagery of every candidate tile: a second criterion in the hot quadtree walk, for the same result as option 2.
2. **Motion lowers only what is requested.** The selection keeps the still detail; while the camera moves fast, each
   visible tile looks up its finer levels without requesting them, draws the deepest one already on the GPU, and
   requests only from the levels the motion allows, with the ranking and the every-second ancestors a coarser
   selection had. The requests are those of before; what is drawn is never coarser than what is resident.
3. **For adaptive quality, start every movement at the preset** and let the governor lower again: a slow device would
   draw half a second to a second of every movement at full cost before the first step, and seconds before the level
   it needs.
4. **For adaptive quality, judge a movement's first frames.** After a rest, the movement's first 6 frames are drawn at
   the preset, back to back (the controller requests them, so their intervals measure the drawing and not the input);
   slower on average than the governor's lowering threshold, the lowered level comes back at once; faster, it is
   forgotten.

## Decision

Options 2 and 4.

- `SurfaceFrame` no longer multiplies the texel threshold by the motion factor; it writes the factor's levels (0 to 3)
  into each imagery loader's `motionLevels`, next to `prefetchPaused`. `wantLayer` looks up that many levels from the
  tile's own down without requesting them, and requests from the first level below them as before. Prefetch stays
  paused and flights keep their plan (F287): only the drawn detail changes. Terrain is unchanged: its selection
  criterion never depended on motion, and it requests what the surface tiles show, as at rest.
- The quality controller's movement from rest starts a trial of 6 frames: it requests a render on each, then compares
  their mean interval with `targetFrameMs × lowerAbove`; slow, it applies the governor's level (`'motion'`), else it
  resets the governor to the preset (`'raise'`, level 0).

## Measurements

Playground `?imagery=world&lon=10&lat=46.3&zoom=8.5&gpuTiming=1`, 1280 × 800, Chromium headless on the machine's GPU
(MacBook, Apple M5, macOS 26), base `3ad1f3c`; three fast pans of 0.5° east and back in 400 ms each, over a view
already loaded; three runs each, ranges over the runs. CPU is the sum of the engine's frame phases.

| While the camera moves                      | Before (`3ad1f3c`) | After             |
| ------------------------------------------- | ------------------ | ----------------- |
| Mean imagery level drawn (still view: 9.92) | 8.56–8.60          | 9.89–9.90         |
| Lowest mean level of a frame                | 7.8                | 9.86              |
| Surface tiles drawn (still view: 48)        | 21.3–21.8          | 46.3–46.4         |
| CPU per frame, p50 / p95, ms                | 1.9–2.2 / 4.3–4.8  | 2.0–2.4 / 3.1–3.8 |
| CPU per frame, max, ms                      | 9.4–12.7           | 4.9–7.1           |
| Frame intervals over 20 ms                  | 1–3                | 0                 |
| GPU per frame, p50, ms                      | 0.84–0.98          | 1.06–1.08         |
| Imagery requests during the pans            | 41–44              | 34–37             |

A moving frame now costs what the still frame of the same view costs (the same tiles), about 0.1 ms more GPU time at
the median here; the longest frames are shorter, since the view no longer switches levels when the camera starts and
stops. With terrain, tilted (`&terrain=terrarium&zoom=9&tilt=50`), the terrain criterion already kept the moving
selection at the still detail: the same pans drew the same 62 tiles before and after, with 17–18 and 16 terrain
requests. Adaptive quality, same page with `?quality=high`: an artificial GPU load (`setGpuLoad(4000)`) lowered the level
to 6 (resolution scale 0.614); with the load removed, before this change every later drag drew at 0.614 with
16.7 ms frames, after it the first drag drew 6 frames at the preset and reset the level to 0; with the load kept, the
level came back after those 6 frames (35 ms each).

## Consequences

- A view that was sharp stays sharp while it moves; only tiles not yet resident show a coarser ancestor until the camera
  slows. A slow device keeps fluid through adaptive quality, which lowers resolution and detail only when frames are
  slow, now also at the start of each movement.
- F713 and F714 record the behaviors; F714 replaces F688, whose first move brought the lowered level back at once.
- Verified by `imagery-draws.test.ts` and `imagery-globe.test.ts` (KB-345, F713), `quality.test.ts` (F714), and the
  existing motion tests (`motion-detail.test.ts`, `flight-preload.test.ts`, `e2e/adaptive-loading.spec.ts` F287 and
  F288).
