---
title: Quickstart for Cube (Nuxt 3 and Vue 3) from the 0.1.0 tarballs
---

# Quickstart for Cube: Nuxt 3 and Vue 3 from the 0.1.0 tarballs

This guide takes a Nuxt 3 (or plain Vue 3 with Vite) application, such as Cube, from nothing to a globe with the
default controls, XYZ or WMS imagery, terrain and a marker layer with click events, using the 0.1.0 pre-release
tarballs instead of the npm registry. Everything here works the same once the packages are published: replace the
`file:` paths with versions. The [integration guide](integration.md) covers the rest (Content Security Policy,
offline packages, provider keys, the Web Component).

## 1. Get the tarballs

The tarballs come from the `v0.1.0` tag ([`release-0.1.0/README.md`](../../release-0.1.0/README.md) rebuilds them
in a few minutes). Copy the folder into the application, for example as `vendor/vibeglobe/`:

```text
vendor/vibeglobe/vibeglobe-core-0.1.0.tgz
vendor/vibeglobe/vibeglobe-renderer-0.1.0.tgz
vendor/vibeglobe/vibeglobe-controls-0.1.0.tgz
vendor/vibeglobe/vibeglobe-worker-0.1.0.tgz
vendor/vibeglobe/vibeglobe-sources-0.1.0.tgz
vendor/vibeglobe/vibeglobe-vue-0.1.0.tgz
vendor/vibeglobe/vibeglobe-ui-0.1.0.tgz
vendor/vibeglobe/vibeglobe-gis-0.1.0.tgz
vendor/vibeglobe/vibeglobe-layers-0.1.0.tgz
… (one per package)
```

## 2. Install them

Name the packages you use as dependencies and every engine package in `overrides`, so npm takes the engine's own
dependencies between its packages from the tarballs too, not from the registry:

```json
{
  "dependencies": {
    "@vibeglobe/vue": "file:vendor/vibeglobe/vibeglobe-vue-0.1.0.tgz",
    "@vibeglobe/sources": "file:vendor/vibeglobe/vibeglobe-sources-0.1.0.tgz",
    "@vibeglobe/layers": "file:vendor/vibeglobe/vibeglobe-layers-0.1.0.tgz",
    "@vibeglobe/ui": "file:vendor/vibeglobe/vibeglobe-ui-0.1.0.tgz"
  },
  "overrides": {
    "@vibeglobe/core": "file:vendor/vibeglobe/vibeglobe-core-0.1.0.tgz",
    "@vibeglobe/renderer": "file:vendor/vibeglobe/vibeglobe-renderer-0.1.0.tgz",
    "@vibeglobe/controls": "file:vendor/vibeglobe/vibeglobe-controls-0.1.0.tgz",
    "@vibeglobe/worker": "file:vendor/vibeglobe/vibeglobe-worker-0.1.0.tgz",
    "@vibeglobe/sources": "file:vendor/vibeglobe/vibeglobe-sources-0.1.0.tgz",
    "@vibeglobe/vue": "file:vendor/vibeglobe/vibeglobe-vue-0.1.0.tgz",
    "@vibeglobe/ui": "file:vendor/vibeglobe/vibeglobe-ui-0.1.0.tgz",
    "@vibeglobe/gis": "file:vendor/vibeglobe/vibeglobe-gis-0.1.0.tgz",
    "@vibeglobe/layers": "file:vendor/vibeglobe/vibeglobe-layers-0.1.0.tgz"
  }
}
```

Then `npm install`. Third-party dependencies (three.js and a few small libraries, all under permissive licenses)
come from the public registry; nothing needs credentials. With TypeScript, also `npm install -D @types/three`.

## 3. Host the assets

The application serves everything itself (VibeGlobe runs no servers). With Nuxt or Vite, the worker program and the
KTX2 transcoder are emitted into the build automatically (Nuxt puts them under `/_nuxt/`). Only the base image, shown
before any tile arrives, is yours: copy `apps/playground/public/imagery/natural-earth-4096.jpg` from the repository
(Natural Earth, public domain) to `public/static/vibeglobe/fallback-base.jpg`.

Without a bundler that resolves `new URL(…, import.meta.url)`, host the worker by hand: copy `vibeglobe-worker.js`
and `vibeglobe-basis.wasm` from `node_modules/@vibeglobe/worker/dist/` to `public/static/vibeglobe/` and pass
`createWorkers({ url: '/static/vibeglobe/vibeglobe-worker.js' })` (serve `.wasm` as `application/wasm`).

## 4. Mount the globe with the default controls

`VibeGlobe` is SSR-safe: the server renders its `placeholder` slot and the engine starts in the browser after
hydration, so no `<ClientOnly>` is needed. Load it only on the page that shows the map:

```html
<!-- pages/map.vue (Nuxt 3) -->
<script setup lang="ts">
  import { defineAsyncComponent } from 'vue';

  const MapView = defineAsyncComponent(() => import('~/components/MapView.vue'));
</script>

<template>
  <MapView style="height: 100vh" />
</template>
```

```html
<!-- components/MapView.vue -->
<script setup lang="ts">
  import { heightmapTerrain, xyzImagery } from '@vibeglobe/sources';
  import { VibeGlobe } from '@vibeglobe/vue';
  import { ref } from 'vue';
  import SitesLayer from './SitesLayer.vue';

  // The element the globe fills: the UI controls and the markers' pointer events live in it.
  const host = ref<HTMLElement>();

  const imagery = [
    xyzImagery({
      id: 'imagery',
      url: 'https://tiles.example.com/imagery/{z}/{x}/{y}.jpg',
      maxLevel: 18,
      attribution: [{ text: 'Imagery © Example', url: 'https://example.com/terms' }],
    }),
  ];
  // Terrain is an engine option: read when the engine starts.
  const options = {
    terrain: heightmapTerrain({
      id: 'terrain',
      url: 'https://tiles.example.com/terrarium/{z}/{x}/{y}.png',
      encoding: 'terrarium', // or 'terrain-rgb'
      maxLevel: 14,
    }),
  };
</script>

<template>
  <div ref="host" style="position: relative; height: 100%">
    <VibeGlobe
      base-imagery-url="/static/vibeglobe/fallback-base.jpg"
      :imagery="imagery"
      :options="options"
      :longitude-deg="12.5"
      :latitude-deg="41.9"
      :zoom="5"
      view-mode="auto"
      style="height: 100%"
    >
      <template #placeholder><p>Loading the map…</p></template>
      <SitesLayer v-if="host" :element="host" />
    </VibeGlobe>
  </div>
</template>
```

Mouse, trackpad, touch and keyboard navigation are on by default (`:controls="false"` turns them off). The `controls`
prop also takes the options of `createControls`, for example `:controls="{ tiltPolicy: true, northUpMaxLatitudeDeg: 85
}"` (F628); the running controls are exposed as `controls` next to `globe`, and `useTiltAvailable()` in a child of the
component (or `useTiltAvailable(globeRef.value.controls)` outside it) tells when the tilt policy keeps the view flat, to
disable a 3D button. Models and model sets need the renderer's glTF loader: `:gltf="gltfLoader"` with `gltfLoader` from
`@vibeglobe/renderer/gltf` (F629). Quantized-mesh
terrain reads its `layer.json` first: create it with `await quantizedMeshTerrain({ id: 'terrain', url:
'https://tiles.example.com/qm/layer.json' })` before the component renders, for example in a parent's `onMounted`.

## 5. A WMS layer instead of (or over) XYZ

`wmsImagery` reads the service's capabilities, so create it in the browser and pass it once ready:

```ts
import { wmsImagery, xyzImagery } from '@vibeglobe/sources';
import { onMounted, shallowRef } from 'vue';

const imagery = shallowRef<unknown[] | undefined>(undefined);
onMounted(async () => {
  const wms = await wmsImagery({
    id: 'wms',
    capabilities: 'https://wms.example.com/?SERVICE=WMS&REQUEST=GetCapabilities',
    layers: ['orthophoto'],
  });
  imagery.value = [xyzImagery({ id: 'base', url: 'https://tiles.example.com/{z}/{x}/{y}.jpg' }), wms];
});
// <VibeGlobe v-if="imagery" :imagery="imagery" … />
```

Layers listed later draw on top; the `layers` prop changes their opacity, visibility and order at runtime, and
`VibeImageryLayer` adds one from the template.

## 6. The default controls and a marker layer with click events

A child component of `VibeGlobe` gets the engine with `useGlobe()`, and the element the globe fills from `MapView`.
One data-layer stack per globe serves both the markers and the UI controls (the controls draw into it), so create
them together once the engine is ready:

```html
<!-- components/SitesLayer.vue -->
<script setup lang="ts">
  import type { Globe } from '@vibeglobe/core';
  import { createGlobeLayers, DataLayer, type GlobeLayers } from '@vibeglobe/layers';
  import { addDefaultControls, createUi, type Ui } from '@vibeglobe/ui';
  import { useGlobe } from '@vibeglobe/vue';
  import { onBeforeUnmount, watch } from 'vue';

  const props = defineProps<{ element: HTMLElement }>();
  const globe = useGlobe();
  let layers: GlobeLayers | undefined;
  let ui: Ui | undefined;

  async function start(engine: Globe): Promise<void> {
    await engine.ready;
    const element = props.element;
    layers = createGlobeLayers(engine, { element });
    // Search, zoom, compass, fullscreen and the coordinate readout; addAllControls adds every navigation control.
    ui = createUi(engine, element, { layers, language: 'it' });
    addDefaultControls(ui);
    const sites = layers.stack.add(
      new DataLayer('point', {
        id: 'sites',
        data: [
          {
            type: 'Feature',
            id: 'rome',
            properties: { name: 'Roma' },
            geometry: { type: 'Point', coordinates: [12.4964, 41.9028] },
          },
          {
            type: 'Feature',
            id: 'milan',
            properties: { name: 'Milano' },
            geometry: { type: 'Point', coordinates: [9.19, 45.4642] },
          },
        ],
        style: { 'circle-color': '#e53935', 'circle-radius': 7 },
      }),
    );
    sites.on('click', ({ feature, position }) => {
      layers?.interaction.select(feature.layerId, feature.id);
      console.log(`${String(feature.properties['name'])} at ${position?.latitudeDeg}, ${position?.longitudeDeg}`);
    });
  }

  watch(globe, (engine) => engine && void start(engine), { immediate: true });
  onBeforeUnmount(() => {
    ui?.destroy();
    layers?.detach();
  });
</script>

<template><slot /></template>
```

Other events: `hover-enter` and `hover-leave` on a layer, and `globe-click` on `VibeGlobe` for a click anywhere (its
`position` is the point on the globe, or undefined in space). `addAllControls(ui)` adds every navigation control
(2D / 3D / Auto, tilt, home, geolocation, layers, scale bar, attribution); the tools (measurement, drawing, saved
views, screenshot, minimap) are added one by one ([UI guide](ui-and-gis.md)).

## 7. Check it

- `npm run dev`, open the page: the globe shows the base image at once, then the tiles; drag, flick, pinch and the
  wheel move it; the controls sit in the corners; a click on a marker logs its name.
- `npm run build && npm run preview` (Nuxt: `node .output/server/index.mjs`): the worker loads from your own origin
  (browser devtools, Network, `vibeglobe-worker` from `/_nuxt/`).
- The [integration guide](integration.md#content-security-policy) lists the Content Security Policy to add.

The repository's `apps/nuxt-example` is a complete Nuxt application with a page per feature group, and the
playground (`npm run dev` in the repository) shows every control and setting at once.
