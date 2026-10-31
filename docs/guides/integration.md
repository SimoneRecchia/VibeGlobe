---
title: Integrating VibeGlobe into an application
---

# Integrating VibeGlobe into an application

This guide takes a new web application from an empty project to a running globe: installation, licensing, Vue and Nuxt
with server-side rendering, lazy loading, hosting the engine's assets on your own origin, a Content Security Policy,
network modes and offline packages, provider keys and attribution. It assumes nothing about your application beyond a
bundler that understands ES modules (Vite, webpack 5, Rollup) and, for the Vue sections, Vue 3.5 or Nuxt 4.

## Installation

The packages are published under the `@vibeglobe` scope of the public npm registry. Install the engine and what you
use:

```sh
npm install @vibeglobe/core @vibeglobe/renderer @vibeglobe/controls @vibeglobe/worker @vibeglobe/sources
npm install @vibeglobe/vue            # Vue 3 and Nuxt
npm install @vibeglobe/web-component  # any framework, or none, through <vibe-globe>
npm install @vibeglobe/offline  # network modes and offline packages, when you need them
```

The Vue adapter brings `@vibeglobe/ui`, `@vibeglobe/gis` and `@vibeglobe/layers` with it (its child components use
them), and the element brings `@vibeglobe/ui` and `@vibeglobe/sources`; npm installs them as dependencies.

| Package                    | What it adds                                                                 |
| -------------------------- | ---------------------------------------------------------------------------- |
| `@vibeglobe/core`          | `createGlobe`, the camera, view modes, streaming and every plug-in interface |
| `@vibeglobe/renderer`      | WebGPU with an automatic WebGL2 fallback                                     |
| `@vibeglobe/controls`      | mouse, touch and keyboard navigation                                         |
| `@vibeglobe/worker`        | the worker pool that decodes tiles off the main thread                       |
| `@vibeglobe/sources`       | tiled sources: XYZ, WMS, WMTS, PMTiles, MBTiles, Google, vector formats      |
| `@vibeglobe/vue`           | the `VibeGlobe` component, composables and child components                  |
| `@vibeglobe/web-component` | the `<vibe-globe>` custom element                                            |
| `@vibeglobe/ui`            | ready-made controls (zoom, compass, search, layers, drawing, measurement, …) |
| `@vibeglobe/gis`           | coordinate formats and transforms, geodesic measurement, view state in URLs  |
| `@vibeglobe/layers`        | data layers: points, markers, labels, lines, polygons, clusters, glTF models |
| `@vibeglobe/offline`       | network modes, the persistent cache and offline packages                     |

## Licensing

VibeGlobe is open source under the [Mozilla Public License 2.0](../../LICENSE.md): you may use, change and
redistribute it for any purpose, commercial included, inside works under any license; a modified VibeGlobe file you
distribute stays available under the MPL 2.0 with its notice. There is no separate commercial license. The
third-party code the packages ship is under permissive licenses only (MIT, BSD, Apache-2.0, ISC), listed in
`THIRD_PARTY_NOTICES.md`; keep that notice with your distribution. Map data and imagery have licenses of their own:
the engine shows each source's required credits (see "Attribution" below).

## A globe without a framework

```ts
import { createControls } from '@vibeglobe/controls';
import { createGlobe } from '@vibeglobe/core';
import { createRenderer } from '@vibeglobe/renderer';
import { xyzImagery } from '@vibeglobe/sources';
import { createWorkers } from '@vibeglobe/worker';

const controls = createControls();
const globe = createGlobe({
  container: document.getElementById('map') as HTMLElement,
  renderer: createRenderer(),
  controls,
  baseImageryUrl: '/static/vibeglobe/fallback-base.jpg',
  workers: createWorkers({ url: '/static/vibeglobe/vibeglobe-worker.js' }),
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
controls.connect(globe); // rotation, tilt and inertia on the engine clock
await globe.ready;
```

The container must have a size; the globe fills it and follows its size changes.

## Vue 3

```html
<script setup lang="ts">
  import { xyzImagery } from '@vibeglobe/sources';
  import { VibeGlobe, useCamera } from '@vibeglobe/vue';
  import { ref } from 'vue';

  const imagery = [
    xyzImagery({ id: 'imagery', url: 'https://tiles.example.com/imagery/{z}/{x}/{y}.jpg', maxLevel: 14 }),
  ];
  const zoom = ref(5);
  const viewMode = ref<'auto' | '2d' | '3d'>('auto');
</script>

<template>
  <VibeGlobe
    base-imagery-url="/static/vibeglobe/fallback-base.jpg"
    :imagery="imagery"
    :longitude-deg="12.5"
    :latitude-deg="41.9"
    :zoom="zoom"
    :view-mode="viewMode"
    style="height: 480px"
  >
    <template #placeholder>Loading the map…</template>
  </VibeGlobe>
</template>
```

Camera props, `viewMode`, `layers` (opacity, visibility and order of the imagery layers) and `networkMode` change the
running engine in place. Inside the default slot, `useGlobe()`, `useCamera()`, `useLoading()` and `useViewMode()`
give reactive state, updated at most once per frame, and the child components `VibeDataLayer`, `VibeMarker` and
`VibeControl` add data layers, markers and `@vibeglobe/ui` controls that follow the template's `v-if` and props.

## Nuxt with server-side rendering

The component is SSR-safe: importing `@vibeglobe/vue` and rendering `VibeGlobe` on the server never touch `window`,
`document` or the GPU. The server renders the `placeholder` slot and the engine starts in the browser after
hydration, so no `<ClientOnly>` wrapper is needed:

```html
<!-- app/pages/map.vue (Nuxt 4's source folder is app/; the page is served at /map) -->
<script setup lang="ts">
  import { defineAsyncComponent } from 'vue';

  // Loaded only on this page: the engine stays out of the other pages' JavaScript.
  const VibeGlobe = defineAsyncComponent(async () => (await import('@vibeglobe/vue')).VibeGlobe);
</script>

<template>
  <VibeGlobe base-imagery-url="/static/vibeglobe/fallback-base.jpg" :zoom="3" style="height: 100vh">
    <template #placeholder><p>Loading the map…</p></template>
  </VibeGlobe>
</template>
```

`nuxt.config.ts` needs nothing special, and an `app/app.vue` with `<NuxtPage />` shows the page. Serve the engine's assets from `public/` (see "Hosting the engine's assets").
Create anything that touches browser APIs (sources with a custom transport, `createOffline`) in `onMounted`, or in a
module you import there. The repository's [`apps/nuxt-example`](https://github.com/SimoneRecchia/VibeGlobe/tree/main/apps/nuxt-example) is a complete example, with a page per feature group.

## Lazy loading with a dynamic import

The engine is large (three.js is most of it), so load it only on the pages that show a map. In Vue:

```ts
import { defineAsyncComponent } from 'vue';

const VibeGlobe = defineAsyncComponent(async () => (await import('@vibeglobe/vue')).VibeGlobe);
```

Without a framework, import inside the code path that shows the map:

```ts
async function showMap(element: HTMLElement): Promise<void> {
  const [{ createGlobe }, { createRenderer }] = await Promise.all([
    import('@vibeglobe/core'),
    import('@vibeglobe/renderer'),
  ]);
  createGlobe({
    container: element,
    renderer: createRenderer(),
    baseImageryUrl: '/static/vibeglobe/fallback-base.jpg',
  });
}
```

Optional parts load themselves on demand: the glTF loader on the first model, `@vibeglobe/layers` when a UI control
first draws, the KTX2 transcoder on the first KTX2 tile.

## The Web Component

```html
<script type="module">
  import { defineVibeGlobe } from '@vibeglobe/web-component';
  defineVibeGlobe(); // registers <vibe-globe>; importing alone registers nothing (SSR-safe)
</script>
<vibe-globe
  base-imagery-url="/static/vibeglobe/fallback-base.jpg"
  imagery-url="https://tiles.example.com/imagery/{z}/{x}/{y}.jpg"
  center="12.5, 41.9"
  zoom="5"
  view-mode="auto"
  ui="all"
  theme="light"
  style="display: block; height: 480px"
></vibe-globe>
```

The `ui` attribute adds the ready-made controls inside the element's shadow tree. Theme them from the host page
through the `ui` part and the documented `--vg-ui-*` variables:

```css
vibe-globe::part(ui) {
  --vg-ui-background: #faf0e6;
  --vg-ui-color: #281460;
}
```

## Hosting the engine's assets

VibeGlobe runs no servers: your application serves the tiles, packages and engine assets itself, from its own origin
(workers must come from the page's origin).

With a bundler (Vite, Nuxt, webpack 5, Rollup) and the Vue component or the element, the worker program and the KTX2 transcoder are emitted into your build automatically (Nuxt puts them under `/_nuxt/`): nothing to copy. With Vite or Nuxt, build workers as ES modules (`worker: { format: 'es' }`, in Nuxt `vite: { worker: { format: 'es' } }`): Vite's default format inlines every task module into one file of about 450 KB, while ES modules keep the vector-tile layout, models, Draco, KTX2 and quantized-mesh decoding in chunks the worker loads with its first such task, so a globe of imagery and terrain starts the worker with about 25 KB. Only the base image is yours to serve, from `public/` (for example `public/static/vibeglobe/fallback-base.jpg`). Hosting the worker by hand applies to `createWorkers({ url })` without a bundler that resolves `new URL(…, import.meta.url)`. The files, under one base path such as `/static/vibeglobe/`:

| File                   | Where it comes from                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vibeglobe-worker.js`  | the bundled worker your bundler emits for `@vibeglobe/worker` (a self-contained module)                                                                                                               |
| `vibeglobe-basis.wasm` | `@vibeglobe/worker`, next to the worker, for KTX2 imagery only                                                                                                                                        |
| `fallback-base.jpg`    | required: an equirectangular JPEG of the whole world (for example 4096 × 2048), shown before any tile arrives; build one with the `vibeglobe-data` tool ([hosting guide](hosting.md)) or use your own |
| `sql-wasm.wasm`        | `sql.js`, only for MBTiles packages read in the browser                                                                                                                                               |

Pass the paths to the engine: `createWorkers({ url: '/static/vibeglobe/vibeglobe-worker.js' })` and
`baseImageryUrl`. Serve `.wasm` as `application/wasm` and `.js` as `text/javascript`. The
[hosting guide](hosting.md) covers tile folders, PMTiles over range requests, CDNs and a LAN server.

## Content Security Policy

The engine evaluates no strings as code and injects no inline `<style>` or `<script>` elements: the UI's stylesheet
is a constructed stylesheet, which `style-src` allows without `'unsafe-inline'`. A strict policy for a site that
serves everything from its own origin and tiles from one tile host:

```text
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self';
  img-src 'self' data: blob: https://tiles.example.com; connect-src 'self' https://tiles.example.com;
  style-src 'self'
```

`'wasm-unsafe-eval'` is needed only for KTX2 imagery and MBTiles packages (WebAssembly). Add every tile, terrain and
package host to `connect-src` (tiles are fetched, then decoded in workers) and to `img-src`; `data:` covers provider
logos given as data URLs.

## Network modes and offline packages

`@vibeglobe/offline` wraps your sources with a persistent cache and offline packages, and decides per request whether
the network may be used:

```ts
import { createOffline, createPackageManager } from '@vibeglobe/offline';
import { pmtilesImagery, xyzImagery } from '@vibeglobe/sources';

const offline = createOffline({ mode: 'hybrid' }); // 'online', 'offline' or 'hybrid' (the default)
const imagery = [
  offline.source(xyzImagery({ id: 'imagery', url: 'https://tiles.example.com/imagery/{z}/{x}/{y}.jpg' })),
];
const packages = createPackageManager(offline, { adapters: { pmtiles: (options) => pmtilesImagery(options) } });
await packages.install('/packages/rome/manifest.json');
offline.setMode('offline'); // never touches the network, not even for health checks
```

With the Vue component, pass the same object and switch the mode reactively:
`<VibeGlobe :imagery="imagery" :offline="offline" :network-mode="mode" … />`. The [offline guide](offline.md) covers
building packages, storage quotas and LAN setups.

## Provider keys and attribution

Keys belong to your application and never to the code you publish:

- Read them from your build environment (`import.meta.env.VITE_GOOGLE_MAPS_API_KEY`, Nuxt's `runtimeConfig.public`),
  never from a committed file, and restrict each key to your site's referrers in the provider's console.
- Google's 2D tiles need your own Map Tiles API key and billing region:

```ts
import { googleImagery } from '@vibeglobe/sources';

const google = googleImagery({
  id: 'google',
  mapType: 'satellite',
  apiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY,
  billingRegion: 'eea', // 'eea' or 'other'
  logoUrl: '/static/vibeglobe/google-logo.png', // your copy of Google's logo, from Google's brand resources
});
```

Attribution: give each source its `attribution` (and its provider profile, which the provider adapters set). The
engine shows the credits of the sources in view in its own attribution element, at the bottom right of the map,
always including the credits and logos a provider requires; `globe.credits()` and the `credits-change` event give you
the list for your own display, and `@vibeglobe/ui`'s `AttributionControl` shows it with the other controls, never
covered by them.

## Checklist

1. The packages install from the npm registry and the license fits your use.
2. The worker program, the base image and any WebAssembly file are served from your origin, under the paths you pass.
3. The page that shows the map imports the engine lazily; server-rendered pages show the placeholder.
4. The Content Security Policy lists every tile and package host.
5. Keys come from the environment and are restricted; the map shows its credits.
