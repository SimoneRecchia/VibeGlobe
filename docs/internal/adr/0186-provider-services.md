# 0186. Provider services: the engine takes a tile, a terrain and a geocoder service; ready providers in their own package

- Status: Accepted
- Date: 2026-11-04
- Milestone: M7, M15 (F698, F699, F700; partly supersedes ADR 0185)

## Context

The owner's brief of 2026-11-04: VibeGlobe as a whole (the renderer and the whole library, not only `@vibeglobe/core`)
must be independent of any map or API. The engine declares what it needs through service interfaces: a tile service,
required, without which the engine cannot work; a service of data for the 3D view and a geocoder, optional, whose
absence turns off only the features that depend on them, without errors. Anyone then connects the provider they want
(Esri, a paid map, a free private map) by implementing the interfaces. The engine is instantiated on any page with one
object holding these implementations and the configuration. Packaging: one npm package for VibeGlobe, with the
engine and the interfaces and no provider implementation; a separate, optional package with ready implementations for
MapTiler, Photon, OpenFreeMap and Esri, so that VibeGlobe can be used at once as today.

What the code had: the core already drew only through interfaces (`ImagerySource`, `TerrainSource`, `Geocoder`), but
starting a globe took five packages wired by hand (renderer, workers, controls, base image, sources); the library still
held a concrete provider (`openStreetMapImagery` for the OSMF's public servers, in `@vibeglobe/sources`); and
`@vibeglobe/presets` holds the Europe preset's concrete sources. PLAN.md already allowed paid providers "only as
optional adapters that respect their terms"; ADR 0185 had removed every such adapter.

## Options considered

1. **Rename the low-level interfaces** (`ImagerySource` → `TileService`, …): the engine's hundreds of uses change and
   the adapters' contract gains nothing; a provider still has to know tilings, transports and decoders.
2. **Service interfaces above the sources:** `TileService` returns the imagery layers (sources built with the generic
   adapters) and optionally a MapLibre style; `TerrainService` returns a terrain source; `GeocoderService` (the
   former `Geocoder`) searches places. One function, `createVibeGlobe(container, options)`, takes them with the
   configuration and wires everything else.
3. **The 3D service** as a service of buildings and terrain together: the buildings of every listed provider come in
   its vector style (MapTiler and OpenFreeMap tiles carry building heights), Esri's are I3S scene layers, which the
   engine does not read. So the 3D view's own data is the relief, which the engine already takes as a `TerrainSource`:
   a `TerrainService` with one method returning it would only wrap it.

For the single package: (a) merge the fourteen workspace packages' sources into one, rewriting every import and
splitting every per-package rule, budget and coverage file; (b) keep the workspace packages as the units the code is
built and tested in, and publish one package, `vibeglobe`, whose tarball holds their builds under subpaths
(`vibeglobe`, `vibeglobe/renderer`, `vibeglobe/vue`, …), the internal packages becoming private; (c) a facade that
depends on the fourteen published packages (one install, but fourteen packages on npm, which is not "one package").

## Decision

Option 2, with the terrain as the existing `TerrainSource`, and packaging (b). As short as it can be (owner,
2026-11-04: "fewer lines, fewer chances of error"):

- `@vibeglobe/core` declares `TileService`, plain data (`{ imagery, style? }`), and `GeocoderService` (`search()`);
  the terrain is a `TerrainSource`. Types only: no byte in the core's bundle.
- `vibeglobe` exports `createVibeGlobe(container, { tiles, terrain?, geocoder?, … })`: it refuses a missing tile
  service (`invalid-option`), starts the renderer, the bundled workers, navigation and the ready-made controls (search
  box with the geocoder, else coordinates only), the base image (one ocean color unless given) and, for a style,
  imports the vector tile modules on demand. It resolves once the first frame is drawn and the style attached. Its
  only options besides the engine's are `ui` (true or false), `controls` (options or false), `language` and
  `baseImageryUrl`.
- `@vibeglobe/providers`, optional, holds functions that return those services: `mapTilerTiles`, `mapTilerTerrain`,
  `esriTiles`, `openFreeMapTiles`, `photonGeocoder`, and the OpenStreetMap sources moved out of `@vibeglobe/sources`.
  Each builds on the public generic adapters only; the engine never imports it.
- No engine package holds a provider: `@vibeglobe/sources` keeps the generic adapters and the profile mechanism.
  `@vibeglobe/presets` (the Europe preset of free sources) is not part of the engine package either.

Terms as read for the profiles: MapTiler and Esri require their credit to stay visible ("© MapTiler © OpenStreetMap
contributors"; "Powered by Esri" with the data sources) and do not allow their tiles in offline packages without a
specific licence, so both profiles forbid `offlinePackaging` and pin the credit; komoot's public Photon instance asks
for reasonable use and holds names in English, German, French and the local language; OpenFreeMap's terms were read
for ADR 0182. This session's network refused `maptiler.com` and `esri.com`: the readings come from the providers'
published attribution rules as known and need the owner's confirmation (open question 40).

## Consequences

- An application starts a globe with one call and any provider; the generic path (`createGlobe` and the packages)
  stays for applications that choose each part.
- ADR 0185's "the library ships no adapter of a paid or proprietary provider" now reads: no engine package does; the
  optional `@vibeglobe/providers`, outside the library, does for MapTiler and Esri, by the owner's request. F679 still
  holds for the library; F700 adds the optional package.
- A globe with workers and no imagery or terrain now runs its imagery runtime, so a style-only map shows its credits
  (KB-343) and accepts imagery layers added later; the separate extension pools for that case are gone (core
  64.99 → 64.61 KB). Without layers or terrain the runtime only steps its worker pool each frame, and motion keeps no
  frames coming.
- The monorepo's root package is `vibeglobe-monorepo`, so that `vibeglobe` names the public package.
- Verified by `packages/vibeglobe/src/create-vibe-globe.test.ts`, `packages/providers/src/providers.test.ts`,
  `e2e/services.spec.ts` and the services guide's type-checked examples.
