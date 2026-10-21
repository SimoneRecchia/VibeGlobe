# Parallel tracks

Since 2026-10-21 several Claude Code sessions work on the repository at the same time (owner's decision). Each session edits only what it owns; anything else it needs from the other track arrives as a pull request that the owning session reviews.

| Track                                               | Session                                                   | Owns                                                                                                                                                                                                                                              |
| --------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine (M3–M8, M10, M11, M13–M15; M12's acceptance) | Main session, branch `claude/happy-galileo-b07j98`        | Every package and app except `packages/tools`, `packages/ui` and the GIS utilities package; every `feature_list.json` entry not listed below                                                                                                      |
| Data pipeline and offline package builder           | Second session, its own branch, pull requests into `main` | `packages/tools` (the command-line tools); M9, data pipeline and default datasets (F330–F347, F551–F554); the offline package builder CLI (F304, F305, F307); the `status` of those entries in `feature_list.json` and their records in `docs/`   |
| UI and GIS utilities (M12)                          | Third session, its own branch, pull requests into `main`  | `packages/ui` (its existing debug overlay included) and a GIS utilities package of its own: coordinate parsing and formatting, CRS transforms, geodesic measurement, view-state serialization; M12 entries F404–F437 and their records in `docs/` |

Rules:

- The main session does not edit `packages/tools`. When it reaches M8 and M9 it uses and reviews the second session's pull request instead of rebuilding that work; the engine side of offline packages (reading, installing and serving packages, network modes; M8) stays with the main session.
- The main session does not edit `packages/ui` or the GIS utilities package. When it reaches M12 it reviews and integrates the third session's pull request instead of rebuilding it, and runs the M12 acceptance (F438).
- The second and third sessions do not edit other packages. A change it needs elsewhere (a core API, a shared script, CI) is asked of the main session or proposed in its pull request for review.
- `feature_list.json` changes only in the `status` of each session's own entries, so the two branches merge without conflicts; shared files (`progress.md`, `docs/open-questions.md`, `docs/follow-ups.md`, `docs/known-bugs.md`) take separate sections or rows per track.

## UI and GIS utilities track: status

The third session's packages are `@vibeglobe/ui` (controls, theming, translations) and `@vibeglobe/gis` (coordinate formats, CRS transforms through proj4js, geodesic measurement on core's geodesics, view-state serialization). Its end-to-end tests (`e2e/ui-*.spec.ts`) mount the ui package on the playground's globe through the Vite dev server (`e2e/support/ui-layer.ts`), so the playground itself is unchanged.

### Stubs for engine features that do not exist yet

| Stub                                                              | Where                                 | Replaced by                                       |
| ----------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------- |
| `ElevationProvider`: terrain height under the pointer             | `packages/ui/src/controls/readout.ts` | Picking with elevation on terrain (F383, M4, M10) |
| `Geocoder`: the pluggable search provider interface               | `packages/ui/src/controls/search.ts`  | The engine's geocoder interface (F208, M6)        |
| `GoTo`: moving to a search result is a `jumpTo`                   | `packages/ui/src/controls/search.ts`  | `flyTo` (F195, M6)                                |
| `ViewMode` (`auto`, `2d`, `3d`) and the chosen tilt in view state | `packages/gis/src/view-state.ts`      | View modes and chosen tilt (F161, F163, F215, M5) |
| Zoom limits 0–22, plus limits learned from steps the engine stops | `packages/ui/src/controls/zoom.ts`    | Zoom constraints (F209, M6)                       |

### Entries waiting for engine features

| Entry      | Waits for                                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| F406       | Terrain elevation under the pointer (F383; terrain, M4)                                                         |
| F407       | Point primitives (F351) and picking (F380, F383)                                                                |
| F408, F409 | Polylines and polygons draped on terrain (F364, F365) and picking (F383)                                        |
| F410       | F407–F409 (the drawn shapes it edits)                                                                           |
| F411       | F407–F410 (measurement runs on the drawing tools); the measurement functions themselves are in `@vibeglobe/gis` |
| F412       | The 2D and tilted 3D phases (F152, F162)                                                                        |
| F413       | Point primitives for the marker and accuracy circle (F351) and `flyTo` with the view-mode rules (F195, F201)    |
| F414       | View modes and the chosen tilt (F161, F163, F215); the serializer is built and tested with the `ViewMode` stub  |
| F415       | `flyTo` (F195) to open a bookmark, and F414                                                                     |
| F416       | Live attribution and logos (F254, F255, F259) and rendering a frame larger than the canvas (no engine API yet)  |
| F417       | The 2D and tilted 3D phases (F152, F162) for the footprint                                                      |
| F421       | View modes and the zoom-driven curves (F161–F163, F548)                                                         |
| F422       | The chosen tilt and its temporary clamp (F215, F210)                                                            |
| F423       | `flyTo` with the view-mode rules and reduced motion (F195, F201, F214)                                          |
| F424       | The engine's live list of credits (F254)                                                                        |
| F425       | Runtime layer order and visibility (F243–F245)                                                                  |
| F426       | The geocoder interface (F208) and `flyTo` (F195); the search box works now with the stubs above                 |
| F434       | The ARIA states of the 2D/3D/Auto toggle (F421) and the layer switcher (F425), which the audit must cover       |
| F436       | Flights that become quick fades with reduced motion (F214, F195)                                                |
| F437       | The attribution control (F424), which the layout must never cover                                               |
