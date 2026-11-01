# @vibeglobe/vue

The Vue 3 adapter of VibeGlobe: the `VibeGlobe` component, composables (`useGlobe`, `useCamera`, `useLoading`,
`useViewMode`, `useControls`, `useTiltAvailable`) and child components (`VibeImageryLayer`, `VibeDataLayer`,
`VibeMarker`, `VibeControl`). It is safe under server-side rendering: the server renders the `placeholder` slot and the
engine starts after mount, so it works in Nuxt without `<ClientOnly>`. Use it for any Vue 3 or Nuxt application.

## Install

Needs `vue` 3.5 or later (a peer dependency). It brings `@vibeglobe/controls`, `@vibeglobe/core`,
`@vibeglobe/layers`, `@vibeglobe/quality`, `@vibeglobe/renderer`, `@vibeglobe/ui` and `@vibeglobe/worker`; install
`@vibeglobe/sources` for the imagery sources.

## Entry points

| Import path      | What                                                      |
| ---------------- | --------------------------------------------------------- |
| `@vibeglobe/vue` | `VibeGlobe`, the composables, the child components, types |

## Example

```html
<div style="height: 480px">
  <VibeGlobe base-imagery-url="/vibeglobe/fallback-base.jpg" :imagery="imagery" :zoom="5" view-mode="auto">
    <template #placeholder>Loading the map…</template>
    <ZoomReadout />
  </VibeGlobe>
</div>
```

```ts
import { useCamera, useGlobe } from '@vibeglobe/vue';
import { defineComponent, h } from 'vue';

export const ZoomReadout = defineComponent({
  setup() {
    const globe = useGlobe();
    const camera = useCamera();
    return () => h('button', { onClick: () => globe.value?.flyTo({ zoom: 3 }) }, camera.zoom.toFixed(1));
  },
});
```

## Pitfalls

- `VibeGlobe` fills its parent: the parent must have a height.
- `baseImageryUrl`, `imagery`, `backend`, `controls`, `gltf`, `workers` and `options` are read once, at start; the
  camera props, `viewMode`, `layers`, `networkMode` and `qualityPreset` change the running engine.
- The composables and child components work inside `VibeGlobe`'s default slot.
- The component creates workers only for `imagery`: with `terrain` in `options` and no `imagery`, pass `workers`.

## Guides

[Integration](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/integration.md) (Vue, Nuxt, lazy
loading, assets) and [data layers](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/data-layers.md).
