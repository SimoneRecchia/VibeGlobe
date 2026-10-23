# Hardening backlog

Owner's direction (2026-10-22): until Monday 26 October 08:00 Europe/Rome every milestone's functionality is built
first (M4 to M14), working end to end with its basic tests; then two weeks of improvements and hardening. Entries whose
only remaining steps are hardening stay `failing` in `feature_list.json` and are listed here with what remains. An
entry is marked `passing` only when all of its steps pass.

Hardening means: performance budgets on real GPUs, soak, chaos and fuzzing runs, the cross-browser matrix, and visual
perfection in edge cases.

| Entry | Milestone | Built and checked                                                                                                                       | Remaining hardening step                                                                                                                                            |
| ----- | --------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F107  | M3        | Trilinear and anisotropic filtering of imagery, unchanged since M3                                                                      | KB-101: shimmer of one-texel stripes at 0.6–1.5 px per texel in the test's view since M5's empty-sky clamp                                                          |
| F157  | M5        | Relief rises with the morph and tilt on the fixture cones (east flank measured)                                                         | KB-097: a ledge of up to 10 px on the west flank of the 0° and 45° cones at a grazing angle; fix planned in the worker (per-tile error of the grid at mesh density) |
| F351  | M10       | Points at their projected positions within 1 px in the globe, 2D and tilted phases, hidden behind the globe (`e2e/data-layers.spec.ts`) | Visual baselines of the three phases; occlusion of screen-sized quads by relief (they use a horizon test, not depth)                                                |
| F353  | M10       | Line width constant in pixels across zooms; the intercontinental line follows the globe (`e2e/data-layers.spec.ts`)                     | Visual baselines; joins without gaps at sharp angles (round joins)                                                                                                  |
| F354  | M10       | Holes empty and a continent-sized polygon on the curved surface in every phase (`e2e/data-layers.spec.ts`)                              | Visual baselines; outlines; triangulation in the worker pool with degenerate input                                                                                  |
| F363  | M10       | Clamped points stand on the terrain shown once it has loaded, placed again when finer terrain arrives (`e2e/data-layers.spec.ts`)       | Smooth re-adjustment during refinement checked by frame differencing; models (glTF)                                                                                 |
| F364  | M10       | A line draped over the fixture peak follows the terrain shown (`e2e/data-layers.spec.ts`)                                               | Every frame of a zoom from the globe to street level and an orbit, through terrain level changes and geomorphing                                                    |
| F365  | M10       | A polygon draped over the fixture peak covers the terrain shown (`e2e/data-layers.spec.ts`)                                             | The same frame recordings; outlines                                                                                                                                 |
