# @vibeglobe/renderer

The renderer plug-in of a VibeGlobe globe: three.js on WebGPU, with an automatic fallback to WebGL2, shaders and GPU
resource management, recovering from device and context loss. Every application passes `createRenderer()` to
`createGlobe`. Its subpath entries draw glTF models, vector tiles, 3D Tiles and the space background, each loaded only
by applications that import it. Importing the package is SSR-safe: three.js loads when a globe starts.

## Install

`@vibeglobe/core`, `@vibeglobe/models` and `three` (pinned to `0.186.1`, with `@types/three`) install with it; there
are no peer dependencies. Vector tiles also need `@vibeglobe/layers`; 3D Tiles need `@vibeglobe/sources`.

## Entry points

| Import                             | What                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `@vibeglobe/renderer`              | `createRenderer` and its `RendererOptions`; `gpuLoad`, a test GPU load |
| `@vibeglobe/renderer/gltf`         | `gltfLoader`, for `createRenderer({ gltf })`                           |
| `@vibeglobe/renderer/vector-tiles` | `createVectorTileTarget`, for `addVectorTiles`                         |
| `@vibeglobe/renderer/tiles3d`      | `threeTileMeshes`, for `tiles3d` of `@vibeglobe/sources/tiles3d`       |
| `@vibeglobe/renderer/starfield`    | `addSpaceBackground`: stars and the Milky Way                          |
| `@vibeglobe/renderer/gpu-probes`   | `runGpuProbes`: GPU precision and depth diagnostics                    |

## Example

```ts
import { createGlobe } from '@vibeglobe/core';
import { createRenderer } from '@vibeglobe/renderer';
import { gltfLoader } from '@vibeglobe/renderer/gltf';

const globe = createGlobe({
  container,
  renderer: createRenderer({ backend: 'auto', gltf: gltfLoader }),
  baseImageryUrl: '/static/vibeglobe/fallback-base.jpg',
});
globe.on('backend-fallback', ({ reason }) => console.info('WebGL2:', reason));
await globe.ready;
console.info(globe.backend); // 'webgpu' or 'webgl2'
```

`RendererOptions`: `backend` (`'auto'`, default, `'webgpu'` or `'webgl2'`), `canvas` (a canvas inside the
container, or an `OffscreenCanvas` with `host`), `antialias` (default `true`), `gpuTiming` (default `false`),
`compressedTextures`, `depth` and `gltf`.

## Pitfalls

- Without `gltf` the renderer draws no models: they fail with an `error` event or a rejected `globe.addModel`.
- An `OffscreenCanvas` without `host` throws a `GlobeError` (`'invalid-option'`).
- After a device loss or a WebGL2 fallback the renderer may replace the canvas: listen for pointer events on the
  container, not on the canvas.
- `globe.ready` rejects with a `GlobeError` (`'unsupported-device'`) when no backend works.

## Guides

- [Integration](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/integration.md)
- [3D models](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/models.md)
- [Vector tiles](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/vector-tiles.md)
- [Space background](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/space-background.md)
