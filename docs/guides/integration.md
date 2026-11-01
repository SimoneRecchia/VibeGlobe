---
title: Integrating VibeGlobe into an application
---

# Integrating VibeGlobe into an application

This guide puts a globe in a web application: with plain TypeScript (`@vibeglobe/core`, `@vibeglobe/renderer`), with
Vue 3 or Nuxt (`@vibeglobe/vue`), or with the `<vibe-globe>` custom element (`@vibeglobe/web-component`). It covers
installation, the base image, server-side rendering, lazy loading, the engine's assets, a Content Security Policy and
attribution. For what goes on the globe read the [sources](sources.md), [terrain](terrain.md),
[data layers](data-layers.md) and [Europe preset](europe-preset.md) guides; for input and ready-made controls, the
[controls](controls.md) and [UI and GIS](ui-and-gis.md) guides.

## Install

Every package is an ES module with TypeScript declarations. Install the set of your integration (until the first
release, the [root README](https://github.com/SimoneRecchia/VibeGlobe/blob/main/README.md) says how to obtain them):

| Integration     | Install                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| Plain TS        | `@vibeglobe/core`, `@vibeglobe/renderer`, `@vibeglobe/controls`, `@vibeglobe/worker`, `@vibeglobe/sources` |
| Vue 3, Nuxt 4   | `@vibeglobe/vue`, `@vibeglobe/sources`, and `vue` 3.5 or later (a peer dependency)                         |
| Web Component   | `@vibeglobe/web-component`                                                                                 |
| Offline, add-on | `@vibeglobe/offline` (network modes, tile cache, offline packages), `@vibeglobe/presets` (ready map types) |

`@vibeglobe/vue` brings `@vibeglobe/controls`, `core`, `layers`, `quality`, `renderer`, `ui` and `worker` as
dependencies; `@vibeglobe/web-component` brings `controls`, `core`, `renderer`, `sources`, `ui` and `worker`.

| Package                    | What it adds                                                                    |
| -------------------------- | ------------------------------------------------------------------------------- |
| `@vibeglobe/core`          | `createGlobe`, the camera, view modes, streaming, events, every plug-in type    |
| `@vibeglobe/renderer`      | `createRenderer`: WebGPU with an automatic WebGL2 fallback                      |
| `@vibeglobe/controls`      | `createControls`: mouse, touch, trackpad and keyboard navigation                |
| `@vibeglobe/worker`        | `createWorkers`: the worker program that decodes tiles off the main thread      |
| `@vibeglobe/sources`       | imagery, terrain and vector tile sources (XYZ, WMS, WMTS, PMTiles, MBTiles, …)  |
| `@vibeglobe/layers`        | data layers: points, markers, labels, lines, polygons, clusters, models         |
| `@vibeglobe/ui`            | ready-made controls: zoom, compass, search, layers, drawing, measurement, …     |
| `@vibeglobe/gis`           | coordinate formats, reference systems, geodesic measurement, view state in URLs |
| `@vibeglobe/vue`           | the `VibeGlobe` component, composables and child components                     |
| `@vibeglobe/web-component` | the `<vibe-globe>` custom element                                               |

## The base image

`baseImageryUrl` is required in every integration: an equirectangular image of the whole world (for example a JPEG
of 4096 × 2048 pixels), which the application serves. The engine drapes it over the globe before any tile arrives and
wherever no imagery layer has a tile. `globe.ready` waits for it, and rejects with a `GlobeError` (`resource-failed`)
when it fails to load. The [hosting guide](hosting.md) shows how to build one from public-domain data.

## Plain TypeScript

```ts
import { createControls } from '@vibeglobe/controls';
import { createGlobe } from '@vibeglobe/core';
import { createRenderer } from '@vibeglobe/renderer';
import { xyzImagery } from '@vibeglobe/sources';
import { createWorkers } from '@vibeglobe/worker/basic';

const globe = createGlobe({
  container, // an element with a size: the globe fills it and follows its size changes
  renderer: createRenderer(),
  controls: createControls(),
  baseImageryUrl: '/vibeglobe/fallback-base.jpg',
  workers: createWorkers(),
  imagery: [
    xyzImagery({
      id: 'imagery',
      url: 'https://tiles.example.com/imagery/{z}/{x}/{y}.jpg',
      maxLevel: 14,
      attribution: [{ text: 'Imagery © Example', url: 'https://example.com/terms' }],
    }),
  ],
  view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 5 },
});
await globe.ready;
globe.flyTo({ longitudeDeg: 9.19, latitudeDeg: 45.46, zoom: 11 });
```

`createGlobe` validates its options and throws a `GlobeError` (`invalid-option`) at once; everything else is
reported through `globe.ready` and the `error` event. It attaches the controls to its canvas and connects them to the
globe itself. `globe.destroy()` frees the GPU memory, workers and listeners.

`@vibeglobe/worker/basic` runs the imagery, terrain, KTX2 and vector-parser tasks. Data-layer clustering, vector tile
layout and glTF models need `createWorkers` from `@vibeglobe/worker`, whose program needs `@vibeglobe/layers` and
`@vibeglobe/models` installed (`@vibeglobe/renderer` brings `@vibeglobe/models`).

### The globe's API at a glance

The TSDoc of `Globe` has every member; these are the ones an application uses first.

| Member                                             | What it does                                                             |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| `ready`                                            | Resolves after the first complete frame; rejects with a `GlobeError`     |
| `camera`                                           | The applied camera: `longitudeDeg`, `latitudeDeg`, `zoom`, `tiltDeg`, …  |
| `jumpTo`, `easeTo`, `flyTo`, `fitBounds`, `goHome` | Move the camera; each returns a `CameraMovement` (a promise, `cancel()`) |
| `setViewMode('2d' \| '3d' \| 'auto')`              | The 2D / 3D / Auto toggle                                                |
| `setConstraints`                                   | Zoom, range, tilt and bounds limits ([controls guide](controls.md))      |
| `screenToGeo`, `geoToScreen`                       | Convert between CSS pixels of the container and WGS84 positions          |
| `on(event, handler)`                               | Subscribes; returns the unsubscribe function                             |
| `imageryLayers`                                    | Order, opacity, visibility and blend of the imagery layers at runtime    |
| `credits()`                                        | The credits of the sources in view                                       |
| `destroy()`                                        | Frees everything; later calls throw `GlobeError` (`destroyed`)           |

Events: `ready`, `frame`, `camera-change` (once per drawn frame), `movestart`, `move`, `moveend`, `idle` (nothing left
to draw), `view-mode-change`, `tile-error`, `credits-change`, `imagery-layers-change`, `tour-waypoint`, `device-lost`,
`device-restored`, `backend-fallback` and `error`. The payloads of `frame`, `idle`, `camera-change` and `move` are
reused objects: read them inside the handler.

## Vue 3

```html
<script setup lang="ts">
  import { xyzImagery } from '@vibeglobe/sources';
  import { VibeGlobe } from '@vibeglobe/vue';
  import { ref } from 'vue';

  const imagery = [
    xyzImagery({ id: 'imagery', url: 'https://tiles.example.com/imagery/{z}/{x}/{y}.jpg', maxLevel: 14 }),
  ];
  const zoom = ref(5);
  const viewMode = ref<'auto' | '2d' | '3d'>('auto');
</script>

<template>
  <div style="height: 480px">
    <VibeGlobe
      base-imagery-url="/vibeglobe/fallback-base.jpg"
      :imagery="imagery"
      :longitude-deg="12.5"
      :latitude-deg="41.9"
      :zoom="zoom"
      :view-mode="viewMode"
    >
      <template #placeholder>Loading the map…</template>
    </VibeGlobe>
  </div>
</template>
```

`VibeGlobe` fills its parent (`width: 100%; height: 100%`): the parent must have a height. It creates the renderer,
the controls and, when `imagery` is set, the workers (`createWorkers()` of `@vibeglobe/worker`) itself.

| Prop                                                           | Applied         | Effect                                                                      |
| -------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------- |
| `baseImageryUrl`                                               | at start        | Required: the base image                                                    |
| `imagery`                                                      | at start        | Imagery sources, bottom first                                               |
| `backend`                                                      | at start        | `'auto'` (default), `'webgpu'` or `'webgl2'`                                |
| `controls`                                                     | at start        | `true` (default), `false`, or the options of `createControls`               |
| `gltf`                                                         | at start        | The glTF loader for models: `gltfLoader` of `@vibeglobe/renderer/gltf`      |
| `workers`                                                      | at start        | Workers of your own, in place of the default                                |
| `options`                                                      | at start        | Any other `GlobeOptions` (`terrain`, `constraints`, `memory`, …)            |
| `longitudeDeg`, `latitudeDeg`, `zoom`, `headingDeg`, `tiltDeg` | live (`jumpTo`) | The camera; only the props that changed move it                             |
| `viewMode`                                                     | live            | `'2d'`, `'3d'` or `'auto'`                                                  |
| `layers`                                                       | live            | Opacity, visibility, blend and order of the imagery layers, by id           |
| `offline`, `networkMode`                                       | live            | The `createOffline()` engine and its network mode                           |
| `qualityPreset`                                                | live            | `'low'`, `'medium'`, `'high'`, `'ultra'` or `'auto'` (`@vibeglobe/quality`) |

Events: `ready` (first frame, with the backend), `load` (the first view finished loading), `camera-change`,
`globe-click` (`{ point, position }`) and `error`. A template ref exposes `globe`, `controls` and `extras`.

Components rendered in the default slot read the globe through composables, updated at most once per frame:
`useGlobe()`, `useCamera()`, `useLoading()`, `useViewMode()`, `useControls()` and `useTiltAvailable()`. The child
components `VibeImageryLayer`, `VibeDataLayer`, `VibeMarker` and `VibeControl` add an imagery layer, a data layer, a
marker or a `@vibeglobe/ui` control, follow their props and are removed when unmounted. `@vibeglobe/layers` and
`@vibeglobe/ui` load with the first child that needs them.

## Nuxt and server-side rendering

`@vibeglobe/vue` is safe to import and render on the server: the server renders the `placeholder` slot, and the engine
starts in `onMounted` after hydration, so no `<ClientOnly>` wrapper is needed.

```html
<!-- app/pages/map.vue -->
<script setup lang="ts">
  import { defineAsyncComponent } from 'vue';

  const VibeGlobe = defineAsyncComponent(async () => (await import('@vibeglobe/vue')).VibeGlobe);
</script>

<template>
  <div style="height: 100vh">
    <VibeGlobe base-imagery-url="/vibeglobe/fallback-base.jpg" :zoom="3">
      <template #placeholder><p>Loading the map…</p></template>
    </VibeGlobe>
  </div>
</template>
```

`nuxt.config.ts` needs nothing for the engine; serve the base image from `public/` (here
`public/vibeglobe/fallback-base.jpg`). Create what touches browser APIs (`createOffline()`, a transport that reads
`location`) in `onMounted`. The repository's
[`apps/nuxt-example`](https://github.com/SimoneRecchia/VibeGlobe/blob/main/apps/nuxt-example) is a complete example.

## The Web Component

```html
<script type="module">
  import { defineVibeGlobe } from '@vibeglobe/web-component';
  defineVibeGlobe(); // registers <vibe-globe>; importing the package registers nothing
</script>
<vibe-globe
  base-imagery-url="/vibeglobe/fallback-base.jpg"
  imagery-url="https://tiles.example.com/imagery/{z}/{x}/{y}.jpg"
  imagery-max-level="14"
  center="12.5, 41.9"
  zoom="5"
  ui="all"
  style="height: 480px"
></vibe-globe>
```

| Attribute                                                      | Applied    | Effect                                                              |
| -------------------------------------------------------------- | ---------- | ------------------------------------------------------------------- |
| `base-imagery-url`                                             | at connect | Required: the base image                                            |
| `imagery-url`, `imagery-max-level`                             | at connect | One XYZ imagery source on top of the `imagery` property's           |
| `backend`                                                      | at connect | `auto` (default), `webgpu` or `webgl2`                              |
| `no-controls`                                                  | at connect | Leaves navigation off                                               |
| `center` (`"<lon>, <lat>"`), `zoom`, `heading-deg`, `tilt-deg` | live       | The camera; only the attribute that changed moves it                |
| `view-mode`                                                    | live       | `auto`, `2d` or `3d`                                                |
| `ui`                                                           | once       | `default` or `all`: the `@vibeglobe/ui` controls in the shadow tree |
| `theme`, `lang`                                                | live       | `light` or `dark`; a registered language of the controls            |

Properties: `globe` (the engine, undefined while disconnected), `ui` (a promise of the UI layer), `imagery` (sources,
read at connect), and `center`, `zoom`, `headingDeg`, `tiltDeg`, `viewMode`, which mirror their attributes. Events
are `CustomEvent`s with the payload in `detail`: `ready`, `load`, `camera-change`, `globe-click` and `error`. The
engine starts when the element is connected and stops when it leaves the document; moving it keeps the engine.

The controls are themed from the page through the `ui` part and the `--vg-ui-*` variables of the
[UI guide](ui-and-gis.md#theming): `vibe-globe::part(ui) { --vg-ui-background: #faf0e6; }`. A page without a bundler
loads `@vibeglobe/web-component/browser` (`dist/browser/vibe-globe.js`), one ES module with the engine bundled and
the worker program next to it; serve that folder as it is.

## Lazy loading

- `createRenderer` imports three.js when the globe starts, so importing `@vibeglobe/renderer` costs no rendering code.
- Import the rest where the map shows: `defineAsyncComponent` in Vue (as in the Nuxt example), a dynamic `import()`
  elsewhere.
- Optional parts load on first use: the glTF loader with the first model, `@vibeglobe/layers` and `@vibeglobe/ui` with
  the first Vue child or UI control that needs them, `@vibeglobe/quality` when `qualityPreset` is set, the KTX2
  transcoder with the first KTX2 tile.

```ts
async function showMap(element: HTMLElement): Promise<void> {
  const [{ createGlobe }, { createRenderer }] = await Promise.all([
    import('@vibeglobe/core'),
    import('@vibeglobe/renderer'),
  ]);
  createGlobe({ container: element, renderer: createRenderer(), baseImageryUrl: '/vibeglobe/fallback-base.jpg' });
}
```

## Hosting the engine's assets

The application serves every file itself; workers must come from the page's own origin.

- With a bundler that resolves `new URL(…, import.meta.url)` (Vite, Nuxt, webpack 5, Rollup), `createWorkers()` makes
  it emit the worker program and its WebAssembly into the build: there is nothing to copy.
- With Vite or Nuxt, build workers as ES modules: `worker: { format: 'es' }` in `vite.config.ts`,
  `vite: { worker: { format: 'es' } }` in `nuxt.config.ts`. Vite's default format puts every task module into the one
  worker file; ES modules keep the parsers, vector tile layout, models and transcoders in chunks the worker loads
  with its first such task.
- `createWorkers({ url })` takes a worker program you host yourself; it throws a `WorkerConfigError` for a
  cross-origin, `blob:` or `data:` URL. The [hosting guide](hosting.md) lists the files, MIME types and server setups.
- The star catalog of the [space background](space-background.md) and `sql-wasm.wasm` for MBTiles packages are the
  other assets, each needed only with its feature.

## Content Security Policy

The engine evaluates no strings as code and creates no `blob:` workers. A policy for a site that serves everything
from its own origin and tiles from one host:

```text
Content-Security-Policy: default-src 'self'; script-src 'self'; worker-src 'self';
  img-src 'self' data: blob: https://tiles.example.com; connect-src 'self' https://tiles.example.com;
  style-src 'self'
```

- Add every tile, terrain and package host to `connect-src` (tiles are fetched, then decoded in workers) and to
  `img-src`; `data:` covers provider logos given as data URLs.
- A worker follows the policy of its own script's response: KTX2 imagery needs `'wasm-unsafe-eval'` in the
  `script-src` of the policy sent with the worker program. MBTiles packages read in the browser run sql.js on the page
  and need it in the page's policy.
- `@vibeglobe/ui` installs its stylesheet as a constructed stylesheet, which `style-src 'self'` allows.
- The `<vibe-globe>` element styles its shadow tree with a `<style>` element, which needs `'unsafe-inline'` in
  `style-src`.

## Network modes and offline packages

`@vibeglobe/offline` wraps sources with a persistent cache and decides per request whether the network may be used:

```ts
import { createOffline } from '@vibeglobe/offline';
import { xyzImagery } from '@vibeglobe/sources';

const offline = createOffline({ mode: 'hybrid' }); // 'online', 'offline' or 'hybrid' (the default)
const imagery = [
  offline.source(xyzImagery({ id: 'imagery', url: 'https://tiles.example.com/imagery/{z}/{x}/{y}.jpg' })),
];
offline.setMode('offline'); // no request leaves the page
```

In Vue, pass the same objects and switch the mode reactively:
`<VibeGlobe :imagery="imagery" :offline="offline" :network-mode="mode" … />`. The [offline guide](offline.md) covers
offline packages, storage quotas and LAN setups.

## Provider keys and attribution

- Keys belong to the application: read them from the build environment (`import.meta.env`, Nuxt's
  `runtimeConfig.public`), never from a committed file, and restrict each key to the site's referrers.
- A paid provider is connected with the generic adapters and a provider profile: the [sources guide](sources.md)
  shows how.
- Give each source its `attribution`. The engine shows the credits of the sources in view at the bottom right of the
  map, always with the credits and logos a provider requires. `globe.credits()` and the `credits-change` event give
  the list.
- `creditsElement: false` hands the credits to the application, which must then show every credit, required ones
  included: `@vibeglobe/ui`'s `AttributionControl` does.

## Licensing

VibeGlobe is under the [Mozilla Public License 2.0](https://github.com/SimoneRecchia/VibeGlobe/blob/main/LICENSE.md):
any use, commercial included, inside works under any license; a modified VibeGlobe file you distribute stays under the
MPL 2.0. The third-party code the packages ship is listed in
[`THIRD_PARTY_NOTICES.md`](https://github.com/SimoneRecchia/VibeGlobe/blob/main/THIRD_PARTY_NOTICES.md). Map data has
licenses of its own: see [data licenses](../data-licenses.md).

## Rules and pitfalls

- The container must have a size: a container of height 0 draws nothing, and the camera waits for a size.
- `imagery` and `terrain` need `workers`; without them `createGlobe` throws `invalid-option`. The Vue component and
  the element create them for `imagery` only: a Vue globe with `terrain` in `options` and no `imagery` needs `workers`.
- Set the element's `imagery` property before the element is connected: it is read once, when the engine starts.
- Props and attributes marked "at start" or "at connect" are read once; change them by remounting, or call the
  engine's own setters through `globe`.
- `createGlobe` is browser-only: call it in `onMounted` or after the page loads, never during server rendering.

## Errors

| Error or code                                                        | When                                                  | What to do                                         |
| -------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------- |
| `GlobeError` `invalid-option`                                        | `createGlobe` or a setter gets an invalid value       | Fix the option the message names                   |
| `GlobeError` `unsupported-device`                                    | No backend can render (`ready` rejects)               | Show a fallback in place of the map                |
| `GlobeError` `resource-failed`                                       | The base image fails to load (`ready` rejects)        | Check `baseImageryUrl` and its MIME type           |
| `GlobeError` `renderer-failed`                                       | The GPU was lost and could not be recovered (`error`) | Recreate the globe or show a fallback              |
| `WorkerConfigError` `cross-origin-url`, `unsupported-url`, `no-page` | `createWorkers({ url })` gets an unusable URL         | Serve the worker program from the page's origin    |
| `tile-error` event, `reason: 'cors'`                                 | A tile server sends no CORS headers                   | Add `Access-Control-Allow-Origin` on the tile host |

## See also

- [Hosting](hosting.md): the files to serve, MIME types, CORS and server setups.
- [Sources](sources.md): imagery, terrain and vector tile adapters, provider profiles.
- [Controls](controls.md) and [UI and GIS](ui-and-gis.md): input, ready-made controls, coordinates.
- [Debugging](debugging.md): logging, counters and traces.
