# @vibeglobe/presets

Ready map types built only from free sources whose terms allow commercial use and redistribution. `europeOpen` returns
Europe's base maps (Satellite, Hybrid, Map, Landscape, Relief), overlays and 3D terrain, with each source's licence and
exact credit, read from an offline package the application hosts, from the network, or both. Use it for a Google
Earth-like map of Europe without vetting providers yourself.

## Install

Depends on `@vibeglobe/core` and `@vibeglobe/sources`. Drawing the map types also takes `@vibeglobe/renderer` and
`@vibeglobe/worker`; the vector map types take `@vibeglobe/layers`; a package takes `@vibeglobe/offline` and is built
with `@vibeglobe/tools`. No peer dependencies.

## Entry points

| Import path                      | What                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `@vibeglobe/presets`             | `europeOpen`, its sources' records (`EUROPE_SOURCES`, `EXCLUDED_SOURCES`), `EUROPE_LAND`  |
| `@vibeglobe/presets/orthophotos` | `europeOrthophotos`, `withAllOnlineSources`, `EUROPE_ORTHOPHOTOS`, `ORTHOPHOTO_MIN_LEVEL` |
| `@vibeglobe/presets/countries`   | `countryBorders(code)`, `COUNTRY_CODES`: country borders to clip a source to              |
| `@vibeglobe/presets/world-land`  | `WORLD_LAND`: the world's land, for the world package (`worldLand`)                       |

## Example

```ts
import { createGlobe } from '@vibeglobe/core';
import { europeOpen } from '@vibeglobe/presets';
import { createWorkers } from '@vibeglobe/worker';

const preset = europeOpen();
const satellite = preset.baseMaps.find((b) => b.id === 'satellite');
const globe = createGlobe({
  container,
  renderer,
  workers: createWorkers(),
  baseImageryUrl: '/imagery/natural-earth-4096.jpg',
  imagery: satellite?.imagery ?? [],
  ...(preset.terrain ? { terrain: preset.terrain } : {}),
});
```

## Pitfalls

- `packageManifestUrl` needs `offline` (`createOffline()` of `@vibeglobe/offline`), or `europeOpen` throws.
- The terrain is chosen when the globe is created: turning 3D terrain on or off creates the globe again.
- Imagery layers can be added only to a globe created with imagery and `workers`: a globe that starts on Map or Relief
  gets Satellite's layers with `visible: false`.
- The overlay (`overlay-*`) and Landscape (`landscape-*`) layer ids are stable: switch them at runtime instead of
  asking for a new style, which reloads every tile.
- `preset.sources` holds every credit the terms ask for: show them (`globe.credits()` gathers the visible ones).

## Guides

- [The Europe preset](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/europe-preset.md)
- [Sources](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/sources.md)
