# Research survey

Before designing each subsystem, study how the best-known open-source engines solve the same problem, write down what was learned, then adopt the best approach or improve on it (`PLAN.md`, Research survey).

Rules:

- Study only open-source projects. Source-available projects with restrictive licenses (for example Mapbox GL JS from version 2, Unreal Engine) are excluded to avoid license contamination.
- Study only, never copy code. Implementations are original.
- For each area, cover the code (how each project solves it), the issue trackers (known bugs, glitches, performance complaints) and the tests and benchmarks.

Each survey is one file `docs/research/<area>.md` with: projects and versions studied; approaches found and their trade-offs; known failure modes (with issue links); how they test it; the approach chosen and why (then an ADR); open questions.

| Area | File | Milestone | Status |
| --- | --- | --- | --- |
| Floating-point precision | `precision.md` | M1 | Not started |
| Depth precision | `depth.md` | M1 | Not started |
| Terrain and imagery levels of detail | `level-of-detail.md` | M1 | Not started |
| Tile scheduling and caching | `scheduling-and-caching.md` | M1 | Not started |
| Globe-to-flat transitions | `globe-to-flat.md` | M1 | Not started |
| Camera control | `camera-control.md` | M1 | Not started |
| GPU resource management and renderer backends | `gpu-and-renderer.md` | M1 | Not started |
| Worker usage | `workers.md` | M1 | Not started |
| Rendering tests and benchmarks | `testing-and-benchmarks.md` | M1 | Not started |
| GPU texture compression and compressed geometry | `compression.md` | M3 | Not started |
| Source adapters, formats and reprojection | `sources-and-formats.md` | M7 | Not started |
| Offline, persistent storage and network adaptation | `offline-and-network.md` | M8 | Not started |
| Data pipeline tooling | `data-pipeline.md` | M9 | Not started |
| Picking | `picking.md` | M10 | Not started |
| Labels | `labels.md` | M10 | Not started |
| Data-layer primitives, draping, clustering and massive point data | `data-layers.md` | M10 | Not started |
| Atmosphere and lighting | `atmosphere.md` | M11 | Not started |
| Vector tiles, buildings and 3D Tiles | `vector-and-3d-tiles.md` | M13 | Not started |

Projects to study (`PLAN.md`): CesiumJS, NASA WorldWind (Web and Java), iTowns, OpenGlobus, osgEarth, 3DTilesRendererJS, loaders.gl; MapLibre GL JS, MapLibre Native, OpenLayers, Leaflet, deck.gl, Tangram; three.js, Babylon.js, PlayCanvas, Filament, Godot, Bevy, O3DE, bgfx; Draco, Basis Universal and KTX2 tools, PMTiles, quantized-mesh tooling, Martini and Delatin; Potree.
