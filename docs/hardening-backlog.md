# Hardening backlog

Steps of feature entries that only harden behavior already built and tested (soak runs, long randomized sessions,
extra devices). They may stay open while the entry's other steps are done; M15 (hardening and release) runs them.

| Entry | Step                                                                            | Built and tested meanwhile                                                                                                  |
| ----- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| F462  | 10 minutes of randomized navigation in a browser within the GPU and RAM budgets | `tiles3d.test.ts`: 600 frames of random cameras keep `TileContentCache` within its budget (overflow only for tiles in view) |
| F451  | Style fuzzing with the view never blank (rendered frames)                       | `vector-style.test.ts`: randomly mutated styles load without an exception and keep evaluable layers                         |
