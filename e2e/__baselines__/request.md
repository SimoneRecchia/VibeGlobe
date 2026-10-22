# Baseline request

Rewriting this file starts the Visual baselines workflow on the pushed branch (docs/guides/visual-tests.md).

Latest request: first baselines of the canonical views and pixel ratios (M2, F071–F074), 2026-10-20; repeated 2026-10-21 after the workflow gained its build step, and again after each pixel-ratio fix (KB-011).

- 2026-10-21T00:57:56Z: frame-start pixel-ratio check
- 2026-10-21T01:04:06Z: the workflow rebases its commit before pushing
- 2026-10-21T07:20:00Z: depth-range scenario with three lanes to the horizon (ADR 0005, second M2 review)
- 2026-10-21T09:40:01Z: frames read through Globe.captureFrame() in device pixels instead of page screenshots (ADR 0012, third M2 review)
- 2026-10-21T13:30:00Z: polar tiles split in latitude only (KB-043, ADR 0006), changing the north-pole view (fourth M2 review)
- 2026-10-21T15:40:00Z: the surface is a Web Mercator quadtree with polar caps (M3 increment 1, ADR 0006 §1): mesh rows follow Mercator y Again on 2026-10-21 for M3 increment 7: the minified-stripes view (F107), and the cross-fade material and sloped skirts (F105, KB-069). Again on 2026-10-21 after the M3 review: the stripes view waits for its imagery before capture. Again on 2026-10-22: draws that do not fade sample one texture (no gamma-2 round trip).
- 2026-10-22T05:08:10Z: four terrain views (terrain-terrarium, terrain-rgb, terrain-quantized-mesh, terrain-smooth; M4, F127, F129, F130); the other views still match their baselines locally
