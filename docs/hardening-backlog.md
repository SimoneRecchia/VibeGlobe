# Hardening backlog

Owner's direction (2026-10-22): until Monday 26 October 08:00 Europe/Rome every milestone's functionality is built
first (M4 to M14), working end to end with its basic tests; then two weeks of improvements and hardening. Entries whose
only remaining steps are hardening stay `failing` in `feature_list.json` and are listed here with what remains. An
entry is marked `passing` only when all of its steps pass.

Hardening means: performance budgets on real GPUs, soak, chaos and fuzzing runs, the cross-browser matrix, and visual
perfection in edge cases.

| Entry | Milestone | Built and checked                                                               | Remaining hardening step                                                                                                                                            |
| ----- | --------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F107  | M3        | Trilinear and anisotropic filtering of imagery, unchanged since M3              | KB-101: shimmer of one-texel stripes at 0.6–1.5 px per texel in the test's view since M5's empty-sky clamp                                                          |
| F157  | M5        | Relief rises with the morph and tilt on the fixture cones (east flank measured) | KB-097: a ledge of up to 10 px on the west flank of the 0° and 45° cones at a grazing angle; fix planned in the worker (per-tile error of the grid at mesh density) |
