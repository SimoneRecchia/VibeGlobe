---
title: Services
---

# Services

`createVibeGlobe` of `vibeglobe` starts a globe in one call with the application's services: a `TileService`
(required), a terrain (`TerrainSource`) and a `GeocoderService` (optional). VibeGlobe ships no map and no provider:
the application brings its own, whether a commercial service, a private map or tiles of its own, through the generic
sources of `vibeglobe/sources`. To assemble the engine piece by piece instead, read the
[integration guide](integration.md); for the sources a service holds, the [sources guide](sources.md).

## Quick start

```ts
import { heightmapTerrain, xyzImagery } from 'vibeglobe/sources';
import { createVibeGlobe, type GeocoderService } from 'vibeglobe';

const geocoder: GeocoderService = {
  async search(query, { language }) {
    const response = await fetch(`https://geo.example.com/?q=${encodeURIComponent(query)}&lang=${language}`);
    const places = (await response.json()) as { name: string; lon: number; lat: number }[];
    return places.map((p) => ({ label: p.name, longitudeDeg: p.lon, latitudeDeg: p.lat }));
  },
};

const { globe, destroy } = await createVibeGlobe(container, {
  tiles: {
    imagery: [xyzImagery({ id: 'mine', url: 'https://maps.example.com/{z}/{x}/{y}.jpg', maxLevel: 18 })],
    style: 'https://maps.example.com/styles/labels.json',
  },
  terrain: heightmapTerrain({ id: 'dem', url: 'https://maps.example.com/dem/{z}/{x}/{y}.png', encoding: 'terrarium' }),
  geocoder,
  view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 5 },
  language: 'it',
});
globe.on('moveend', () => console.log(globe.camera.zoom));
window.addEventListener('pagehide', destroy);
```

This shows the application's imagery with its labels over its terrain, a search box that finds places with its
geocoder, navigation and the ready-made controls in Italian. `container` is an element with a size; the globe fills
it.

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

## Any provider

A provider plugs in with the generic sources: `xyzImagery`, `wmtsImagery` or `pmtilesImagery` for its imagery, a
MapLibre style for its vector map, `heightmapTerrain` or `quantizedMeshTerrain` for its relief. A transport adds its
key or token only when a request is made; a source's `attribution` and `profile` carry its credits and rules (the
[sources guide](sources.md) lists them).

## Options

`createVibeGlobe(container, options)` takes the services and every `GlobeOptions` field the engine does not build
itself (`view`, `quality`, `constraints`, `atmosphere`, `home`, `memory`, …).

| Option           | Type                       | Default                   | Effect                                            |
| ---------------- | -------------------------- | ------------------------- | ------------------------------------------------- |
| `ui`             | `boolean`                  | `true`                    | search, zoom, compass, fullscreen and coordinates |
| `controls`       | `ControlsOptions \| false` | the defaults              | mouse, touch and keyboard navigation              |
| `language`       | `string`                   | `'en'`                    | the controls' language and the map's names        |
| `baseImageryUrl` | `string`                   | NASA Blue Marble, shipped | the world image shown where no tile is loaded yet |

The promise resolves with `globe` (the `Globe`), `ui` (the controls, `undefined` with `ui: false`; add more with
`ui.add`) and `destroy()`, which stops the globe and removes its canvas and controls.

## Rules and pitfalls

- Map data belongs to its providers: the application holds their keys, pays their plans and keeps to their terms,
  offline use and credits included.
- The style loads before the promise resolves; a style that fails to load rejects it and stops the globe.
- Keys in tile URLs are visible to anyone who opens the page: restrict them to your domains in the provider's console.
- Without `baseImageryUrl` the globe starts on the NASA Blue Marble shipped in the package (`dayImageUrl()` of
  `vibeglobe/sources`, 0.85 MB), which your bundler copies to your assets; pass your own image to replace it.

## Errors

| Error or code        | When                                       | What to do                      |
| -------------------- | ------------------------------------------ | ------------------------------- |
| `invalid-option`     | no `tiles`                                 | pass a `TileService`            |
| `resource-failed`    | the style or the base image did not load   | check the URL, CORS and the key |
| `unsupported-device` | the device draws neither WebGPU nor WebGL2 | show a fallback                 |

## See also

- [Integration](integration.md): the engine assembled by hand, Vue, Nuxt and the Web Component.
- [Sources](sources.md): the generic sources a service holds, credits and provider profiles.
- [Vector tiles](vector-tiles.md): styles, labels and buildings.
- [UI and GIS](ui-and-gis.md): the search box and the other controls.
