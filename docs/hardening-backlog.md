# Hardening backlog

Steps of feature entries that are hardening only (real-GPU budgets, soak, cross-browser matrix, edge-case visual
perfection). They may stay failing while the rest of their entry is built and verified; each is listed here with what
remains. Parallel tracks keep a section each.

## Atmosphere track (M11)

| Entry      | Step                               | What remains                                                                                                                             |
| ---------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| F391–F396  | Real GPUs and the reference tablet | The sky and haze march (ADR 0034) timed on the reference desktop and tablet within the GPU budget; Hillaire LUTs if the tablet misses it |
| F391, F393 | Firefox and Safari                 | The harness checks in the cross-browser job once the engine draws the atmosphere (the container has Chromium only)                       |
| F392       | Banding on large real displays     | The dithering checked by eye on an 8-bit desktop monitor at 4K; the automated measure runs at 480 × 320 on SwiftShader                   |
| F394       | Edge cases                         | Haze over high mountains seen from below their summits (ground below the eye's horizon), polar views                                     |
