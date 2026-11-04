---
title: Services and providers
---

# Services and providers

`createVibeGlobe` of `vibeglobe` starts a globe in one call with the application's services: a `TileService`
(required), a terrain (`TerrainSource`) and a `GeocoderService` (optional). The engine knows no map provider:
anything that implements these interfaces plugs in, whether a commercial service, a private map or tiles of your own.
`@vibeglobe/providers` holds ready ones for MapTiler, Esri, OpenFreeMap and Photon; it is optional. To assemble the
engine piece by piece instead, read the [integration guide](integration.md); for the sources a service holds, the
[sources guide](sources.md).

## Quick start

```ts
import { mapTilerTerrain, mapTilerTiles, photonGeocoder } from '@vibeglobe/providers';
import { createVibeGlobe } from 'vibeglobe';

const { globe, destroy } = await createVibeGlobe(container, {
  tiles: mapTilerTiles({ key: customerKey }),
  terrain: mapTilerTerrain({ key: customerKey }),
  geocoder: photonGeocoder(),
  view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 5 },
  language: 'it',
});
globe.on('moveend', () => console.log(globe.camera.zoom));
window.addEventListener('pagehide', destroy);
```

This shows MapTiler's satellite imagery on its terrain, a search box that finds places with Photon, navigation and
the ready-made controls in Italian. `container` is an element with a size; the globe fills it.

## The services

| Option     | Type              | Required | Without it                                      |
| ---------- | ----------------- | -------- | ----------------------------------------------- |
| `tiles`    | `TileService`     | yes      | `createVibeGlobe` rejects with `invalid-option` |
| `terrain`  | `TerrainSource`   | no       | the surface is flat (the WGS84 ellipsoid)       |
| `geocoder` | `GeocoderService` | no       | the search box takes coordinates only           |

- `TileService` is `{ imagery, style? }`: `imagery` holds the raster layers, bottom first (sources such as
  `xyzImagery`, or layers of sources), empty for a map drawn only from its style; `style` is a MapLibre style, its
  URL or JSON, drawn over the imagery (streets, labels, 3D buildings).
- The terrain is a `TerrainSource`: `heightmapTerrain`, `quantizedMeshTerrain` or a source of its own. A style's 3D
  buildings draw with or without it.
- `GeocoderService` has one method, `search(query, { signal, language })`, which resolves `GeocoderResult` places,
  empty when none, and stops when `signal` aborts.

## Ready providers

| Function           | Returns           | Provider                                                            | Key               |
| ------------------ | ----------------- | ------------------------------------------------------------------- | ----------------- |
| `mapTilerTiles`    | `TileService`     | MapTiler: `map: 'satellite'` (default) or a map id                  | `key`, required   |
| `mapTilerTerrain`  | `TerrainSource`   | MapTiler Terrain-RGB, levels 0 to 14                                | `key`, required   |
| `esriTiles`        | `TileService`     | Esri: `map: 'imagery'` (default), `'streets'`, `'topo'`             | `token`, optional |
| `openFreeMapTiles` | `TileService`     | OpenFreeMap: `style: 'liberty'` (default), `'bright'`, `'positron'` | none              |
| `photonGeocoder`   | `GeocoderService` | Photon: komoot's public instance, or `url`                          | none              |

`mapTilerTiles` with `map: 'streets-v2'`, `'outdoor-v2'`, `'topo-v2'` or another MapTiler map id draws that map from
its vector style. `openStreetMapImagery` and `openStreetMapHostedImagery` of the same package return OpenStreetMap
sources for a `TileService` of your own.

## Your own services

Any provider plugs in with the generic sources of `@vibeglobe/sources`:

```ts
import { heightmapTerrain, xyzImagery } from '@vibeglobe/sources';
import { createVibeGlobe, type GeocoderService } from 'vibeglobe';

const geocoder: GeocoderService = {
  async search(query, { language }) {
    const response = await fetch(`https://geo.example.com/?q=${encodeURIComponent(query)}&lang=${language}`);
    const places = (await response.json()) as { name: string; lon: number; lat: number }[];
    return places.map((p) => ({ label: p.name, longitudeDeg: p.lon, latitudeDeg: p.lat }));
  },
};

await createVibeGlobe(container, {
  tiles: {
    imagery: [xyzImagery({ id: 'mine', url: 'https://maps.example.com/{z}/{x}/{y}.jpg', maxLevel: 18 })],
    style: 'https://maps.example.com/styles/labels.json',
  },
  terrain: heightmapTerrain({ id: 'dem', url: 'https://maps.example.com/dem/{z}/{x}/{y}.png', encoding: 'terrarium' }),
  geocoder,
});
```

A source's `attribution` and `profile` carry the provider's credits and rules; the [sources guide](sources.md) lists
them.

## Options

`createVibeGlobe(container, options)` takes the services and every `GlobeOptions` field the engine does not build
itself (`view`, `quality`, `constraints`, `atmosphere`, `home`, `memory`, …).

| Option           | Type                       | Default        | Effect                                            |
| ---------------- | -------------------------- | -------------- | ------------------------------------------------- |
| `ui`             | `boolean`                  | `true`         | search, zoom, compass, fullscreen and coordinates |
| `controls`       | `ControlsOptions \| false` | the defaults   | mouse, touch and keyboard navigation              |
| `language`       | `string`                   | `'en'`         | the controls' language and the map's names        |
| `baseImageryUrl` | `string`                   | one ocean blue | the world image shown where no tile is loaded yet |

The promise resolves with `globe` (the `Globe`), `ui` (the controls, `undefined` with `ui: false`; add more with
`ui.add`) and `destroy()`, which stops the globe and removes its canvas and controls.

## Rules and pitfalls

- Map data belongs to its providers: the application holds their keys, pays their plans and keeps to their terms.
  MapTiler and Esri tiles cannot go in offline packages, and their credits stay visible.
- komoot's public Photon instance is for light use only; a product with many searches runs its own and passes its
  `url`.
- The style loads before the promise resolves; a style that fails to load rejects it and stops the globe.
- Keys in tile URLs are visible to anyone who opens the page: restrict them to your domains in the provider's console.
- With a strict Content Security Policy, allow `data:` in `connect-src` or pass `baseImageryUrl` from your own origin.

## Errors

| Error or code                     | When                                               | What to do                          |
| --------------------------------- | -------------------------------------------------- | ----------------------------------- |
| `invalid-option`                  | no `tiles`                                         | pass a `TileService`                |
| `resource-failed`                 | the style or the base image did not load           | check the URL, CORS and the key     |
| `unsupported-device`              | the device draws neither WebGPU nor WebGL2         | show a fallback                     |
| `SourceConfigError` `missing-key` | `mapTilerTiles` or `mapTilerTerrain` without a key | pass the application's MapTiler key |

## See also

- [Integration](integration.md): the engine assembled by hand, Vue, Nuxt and the Web Component.
- [Sources](sources.md): the generic sources a service holds, credits and provider profiles.
- [Vector tiles](vector-tiles.md): styles, labels and buildings.
- [UI and GIS](ui-and-gis.md): the search box and the other controls.
