# 0187. No maps in the library: no provider package, the Europe preset is the playground's own

- Status: Accepted
- Date: 2026-11-04
- Milestone: M7, M15 (F701, F702; partly supersedes ADR 0186 and ADR 0182)

## Context

The owner's brief of 2026-11-04, after ADR 0186: VibeGlobe provides no map at all. The library accepts any tiles;
whoever uses it brings the maps, online and offline, and the services that reach them. The first application, which
had taken its map types from `europeOpen`, now assembles its satellite, map and relief itself from its own services
(its backend, its cloud, Esri) and its own offline packages, and uses no provider of the library.

What the code had: `@vibeglobe/providers`, optional, with ready services for MapTiler, Esri, OpenFreeMap and Photon and
the OpenStreetMap public and self-hosted sources (ADR 0186); `@vibeglobe/presets`, published, with the Europe preset's
sources, styles, land polygons and orthophoto records (ADR 0182). The playground's tour and the Europe preset's
end-to-end tests draw from `@vibeglobe/presets`.

## Options considered

1. **Keep the providers as an optional package:** it is still a set of maps the library offers, against the brief.
2. **Delete the Europe preset with the providers:** the playground would lose its Europe chapters and their tests,
   which exercise the engine on real-looking maps (fades, sea keying, styles, the offline package).
3. **Remove the providers; keep the Europe preset as the playground's own maps,** a private workspace package under
   `apps/` that is never packed or published, like any application's map code.

## Decision

Option 3.

- `@vibeglobe/providers` is removed. The OpenStreetMap adapters and their public and self-hosted profiles go with it;
  ADR 0032 stays as the reading of the policy that an application keeps to when it uses those servers. The opt-in live
  run reaches the OpenStreetMap servers through the generic `xyzImagery`, identifying itself as the policy asks.
- `@vibeglobe/presets` moves to `apps/presets`, `private`, with its tests and its guide (`apps/presets/europe-preset.md`,
  still type-checked by `scripts/integration/europe-preset-guide.test.ts`); it leaves the public guides, the README and
  `llms.txt`. Its budget and the providers' leave `quality/budgets.json` with the packages.
- The generic sources, the profile mechanism and the service interfaces stay: any provider, paid or free, is the
  application's code through them (ADR 0185, ADR 0186). The data pipeline keeps its dataset configurations: they are
  what it builds packages from, not maps the engine shows.
- F701 records the rule and is tested by `scripts/checks/no-maps.test.ts`; F702 replaces F698 for the single package,
  which is still to be built.

## Consequences

- No published package names a map or geocoding host; an application starts a globe with its own tiles
  (`e2e/services.spec.ts` starts one from fixture tiles alone).
- Open question 40 (MapTiler's and Esri's terms) has no code left to decide and is resolved.
- The Europe preset's feature entries keep passing: their behavior lives on in the playground's package.
