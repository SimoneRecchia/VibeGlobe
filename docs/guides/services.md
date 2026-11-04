---
title: Services and providers
---

# Services and providers

`createVibeGlobe` of `vibeglobe` starts a globe in one call with the application's services: a `TileService`
(required), a `TerrainService` and a `GeocoderService` (optional). The engine knows no map provider: anything that
implements these interfaces plugs in, whether a commercial service, a private map or tiles of your own.
`@vibeglobe/providers` holds ready implementations for MapTiler, Esri, OpenFreeMap and Photon; it is optional. To
assemble the engine piece by piece instead, read the [integration guide](integration.md); for the sources a service
returns, the [sources guide](sources.md).

## Quick start

```ts
import { MapTilerTerrain, MapTilerTiles, PhotonGeocoder } from '@vibeglobe/providers';
import { createVibeGlobe } from 'vibeglobe';

const { globe, destroy } = await createVibeGlobe(container, {
  tiles: new MapTilerTiles({ key: customerKey }),
  terrain: new MapTilerTerrain({ key: customerKey }),
  geocoder: new PhotonGeocoder(),
  view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 5 },
  language: 'it',
});
globe.on('moveend', () => console.log(globe.camera.zoom));
window.addEventListener('pagehide', destroy);
```

This shows MapTiler's satellite imagery on its terrain, a search box that finds places with Photon, navigation and
the default controls in Italian. `container` is an element with a size; the globe fills it.

## The services

| Service           | Required | Methods                                           | Without it                                 |
| ----------------- | -------- | ------------------------------------------------- | ------------------------------------------ |
| `TileService`     | yes      | `imagery()`, optional `style()`, `transformUrl()` | `createVibeGlobe` rejects `invalid-option` |
| `TerrainService`  | no       | `terrain()`                                       | the surface is flat (the WGS84 ellipsoid)  |
| `GeocoderService` | no       | `search(query, { signal, language })`             | the search box takes coordinates only      |

- `TileService.imagery()` returns the raster layers, bottom first: sources (`ImagerySource`) or layers of sources
  with their options. It returns an empty array for a map drawn only from its style.
- `TileService.style()` returns a MapLibre style, its URL or its JSON, drawn over the imagery: streets, labels and 3D
  buildings. It returns `undefined`, or is absent, for a map without one. `transformUrl()` rewrites every URL the style
  leads to (a key, a mirror).
- `TerrainService.terrain()` returns a `TerrainSource`: `heightmapTerrain`, `quantizedMeshTerrain` or a source of its
  own. The 3D buildings of a style draw with or without terrain.
- `GeocoderService.search` resolves `GeocoderResult` places, empty when none, and stops when `signal` aborts.

The engine calls `imagery()`, `style()` and `terrain()` once, when the globe starts.

## Ready providers

| Class              | Service           | Provider                                                        | Key               |
| ------------------ | ----------------- | --------------------------------------------------------------- | ----------------- |
| `MapTilerTiles`    | `TileService`     | MapTiler: `map: 'satellite'` (default) or a style               | `key`, required   |
| `MapTilerTerrain`  | `TerrainService`  | MapTiler Terrain-RGB, levels 0 to 14                            | `key`, required   |
| `EsriTiles`        | `TileService`     | Esri: `map: 'imagery'` (default), `streets`, `topo`             | `token`, optional |
| `OpenFreeMapTiles` | `TileService`     | OpenFreeMap: `style: 'liberty'` (default), `bright`, `positron` | none              |
| `PhotonGeocoder`   | `GeocoderService` | Photon, komoot's public instance or `url`                       | none              |

`MapTilerTiles` with `map: 'streets-v2'`, `'outdoor-v2'`, `'topo-v2'` or another MapTiler map id draws that map from
its vector style; `'satellite'` draws the satellite imagery. `openStreetMapImagery` and `openStreetMapHostedImagery`
of the same package return OpenStreetMap sources for a `TileService` of your own.

```ts
import { EsriTiles, OpenFreeMapTiles } from '@vibeglobe/providers';
import { createVibeGlobe } from 'vibeglobe';

await createVibeGlobe(container, { tiles: new OpenFreeMapTiles({ style: 'positron' }), ui: false });
await createVibeGlobe(container, { tiles: new EsriTiles({ map: 'topo', token: customerKey }) });
```

## Your own services

Any provider plugs in by implementing the interfaces, with the generic sources of `@vibeglobe/sources`:

```ts
import { heightmapTerrain, xyzImagery } from '@vibeglobe/sources';
import { createVibeGlobe, type GeocoderService, type TerrainService, type TileService } from 'vibeglobe';

class MyTiles implements TileService {
  imagery() {
    const url = 'https://maps.example.com/satellite/{z}/{x}/{y}.jpg';
    return [xyzImagery({ id: 'my-satellite', url, maxLevel: 18, attribution: [{ text: '© Example' }] })];
  }
  style() {
    return 'https://maps.example.com/styles/labels.json';
  }
}

class MyTerrain implements TerrainService {
  terrain() {
    const url = 'https://maps.example.com/dem/{z}/{x}/{y}.png';
    return heightmapTerrain({ id: 'my-dem', url, encoding: 'terrarium', maxLevel: 12 });
  }
}

class MyGeocoder implements GeocoderService {
  async search(query: string, options: { readonly signal: AbortSignal; readonly language: string }) {
    const url = `https://geo.example.com/?q=${encodeURIComponent(query)}&lang=${options.language}`;
    const response = await fetch(url, { signal: options.signal });
    const places = (await response.json()) as { name: string; lon: number; lat: number }[];
    return places.map((p) => ({ label: p.name, longitudeDeg: p.lon, latitudeDeg: p.lat }));
  }
}

await createVibeGlobe(container, { tiles: new MyTiles(), terrain: new MyTerrain(), geocoder: new MyGeocoder() });
```

A source's `attribution` and `profile` carry the provider's credits and rules; the [sources guide](sources.md) lists
them.

## Options

`createVibeGlobe(container, options)` takes the services and every `GlobeOptions` field the engine does not build
itself (`view`, `quality`, `constraints`, `atmosphere`, `home`, `memory`, …).

| Option           | Type                             | Default        | Effect                                                           |
| ---------------- | -------------------------------- | -------------- | ---------------------------------------------------------------- |
| `tiles`          | `TileService`                    | required       | the map's imagery and style                                      |
| `terrain`        | `TerrainService`                 | none           | the relief of the 3D view                                        |
| `geocoder`       | `GeocoderService`                | none           | place search in the search box                                   |
| `ui`             | `'default' \| 'all' \| false`    | `'default'`    | search, zoom, compass, fullscreen, coordinates; or every control |
| `controls`       | `boolean \| ControlsOptions`     | `true`         | mouse, touch and keyboard navigation                             |
| `language`       | `string`                         | `'en'`         | the controls' language and the map's names                       |
| `backend`        | `'auto' \| 'webgpu' \| 'webgl2'` | `'auto'`       | WebGPU, else WebGL2                                              |
| `baseImageryUrl` | `string`                         | one ocean blue | the world image shown where no tile is loaded yet                |

The promise resolves with `globe` (the `Globe`), `ui` (the controls, `undefined` with `ui: false`) and `destroy()`,
which stops the globe and removes its canvas and controls.

## Rules and pitfalls

- Map data belongs to its providers: the application holds their keys, pays their plans and keeps to their terms.
  MapTiler and Esri forbid offline packaging of their tiles; their credits stay visible.
- komoot's public Photon instance is for light use only; a product with many searches runs its own instance and passes
  its `url`.
- The tile service's style loads before the promise resolves; a style that fails to load rejects it and stops the
  globe.
- Keys in tile URLs are visible to anyone who opens the page: restrict them to your domains in the provider's console.
- With a strict Content Security Policy, allow `data:` in `connect-src` or pass `baseImageryUrl` from your own origin.

## Errors

| Error or code                     | When                                               | What to do                          |
| --------------------------------- | -------------------------------------------------- | ----------------------------------- |
| `invalid-option`                  | `tiles` missing or without `imagery()`             | pass a `TileService`                |
| `resource-failed`                 | the style or the base image did not load           | check the URL, CORS and the key     |
| `unsupported-device`              | the device draws neither WebGPU nor WebGL2         | show a fallback                     |
| `SourceConfigError` `missing-key` | `MapTilerTiles` or `MapTilerTerrain` without a key | pass the application's MapTiler key |

## See also

- [Integration](integration.md): the engine assembled by hand, Vue, Nuxt and the Web Component.
- [Sources](sources.md): the generic sources a service returns, credits and provider profiles.
- [Vector tiles](vector-tiles.md): styles, labels and buildings.
- [UI and GIS](ui-and-gis.md): the search box and the other controls.
