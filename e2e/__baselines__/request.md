# Baseline request

Rewriting this file starts the Visual baselines workflow on the pushed branch (docs/guides/visual-tests.md).

Latest request: first baselines of the canonical views and pixel ratios (M2, F071–F074), 2026-10-20; repeated 2026-10-21 after the workflow gained its build step, and again after each pixel-ratio fix (KB-011).

- 2026-10-21T00:57:56Z: frame-start pixel-ratio check
- 2026-10-21T01:04:06Z: the workflow rebases its commit before pushing
- 2026-10-21T07:20:00Z: depth-range scenario with three lanes to the horizon (ADR 0005, second M2 review)
- 2026-10-21T09:40:01Z: frames read through Globe.captureFrame() in device pixels instead of page screenshots (ADR 0012, third M2 review)
- 2026-10-21T13:30:00Z: polar tiles split in latitude only (KB-043, ADR 0006), changing the north-pole view (fourth M2 review)
- 2026-10-21T15:40:00Z: the surface is a Web Mercator quadtree with polar caps (M3 increment 1, ADR 0006 §1): mesh rows follow Mercator y Again on 2026-10-21 for M3 increment 7: the minified-stripes view (F107), and the cross-fade material and sloped skirts (F105, KB-069). Again on 2026-10-21 after the M3 review: the stripes view waits for its imagery before capture. Again on 2026-10-22: draws that do not fade sample one texture (no gamma-2 round trip).
- 2026-10-21T23:00:00Z: the ui package's controls in the light and dark themes (F430, UI and GIS track)
- 2026-10-22T05:08:10Z: four terrain views (terrain-terrarium, terrain-rgb, terrain-quantized-mesh, terrain-smooth; M4, F127, F129, F130); the other views still match their baselines locally
- 2026-10-22T11:43:00Z: the four terrain views again after KB-080 and KB-081 (tile distances near the ground, the eye above the finest terrain); the quantized-mesh view waits up to 150 s for its imagery
- 2026-10-22T17:15:33Z: the four terrain views again after KB-090 and KB-092 (Mercator terrain error scaled with latitude, at most two levels per morph)
- 2026-10-23T06:15:46Z: data-layer circles and an ellipse in the globe, 2D and tilted phases (M10, F356)
- 2026-10-23T08:28:26Z: data-layer markers at device pixel ratios 1 and 2 and labels in several scripts, fonts, halos and offsets (M10, F352, F357)
- 2026-10-23T13:56:15Z: tile placement of both tiling schemes in globe, 2D, tilted and polar views (M7, F224, F225)
- 2026-10-24T19:57:57Z: data-layer labels drawn from signed distance fields (M10, F358, ADR 0045): the data-labels view
- 2026-10-25T01:05:31Z: the space background on both backends (M11, F608, ADR 0181): `e2e/starfield.spec.ts` @baseline
