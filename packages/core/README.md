# @vibeglobe/core

The framework-agnostic engine of VibeGlobe. `createGlobe` builds an interactive globe in an element: camera movements,
the globe-to-flat-map morph and the 2D / 3D / Auto view modes, tile streaming, events, credits, typed errors
(`GlobeError`) and the plug-in types the other packages implement. Every application needs it; it draws
through a renderer from `@vibeglobe/renderer`.

## Install

`@vibeglobe/core` has no dependencies. A globe also needs `@vibeglobe/renderer`; imagery and terrain need
`@vibeglobe/worker` and sources from `@vibeglobe/sources`; navigation needs `@vibeglobe/controls`. `@vibeglobe/vue`
and `@vibeglobe/web-component` bring them.

## Entry points

| Import path                   | What                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `@vibeglobe/core`             | `createGlobe`, the `Globe` and `GlobeOptions` types, `GlobeError`, projections, tiling, plug-in interfaces |
| `@vibeglobe/core/geodesy`     | WGS84 geodesics: inverse and direct problems, path lengths, polygon areas                                  |
| `@vibeglobe/core/coverage`    | `coverageArea`, `coverageTest`: source areas as polygons, for source adapters                              |
| `@vibeglobe/core/decoders`    | Tile decoders the workers run: heightmaps, quantized mesh, KTX2, geoid files                               |
| `@vibeglobe/core/layers`      | Layer point projection and transport failure classes, for renderers and layers                             |
| `@vibeglobe/core/diagnostics` | `FrameStats`: frame times and rates over a window                                                          |

## Example

```ts
import { createGlobe, GlobeError } from '@vibeglobe/core';
import { createRenderer } from '@vibeglobe/renderer';

const globe = createGlobe({ container, renderer: createRenderer(), baseImageryUrl: '/vibeglobe/fallback-base.jpg' });
globe.on('moveend', ({ outcome }) => console.log(outcome, globe.camera.zoom));
try {
  await globe.ready;
} catch (error) {
  if (error instanceof GlobeError && error.code === 'unsupported-device') container.textContent = 'No WebGL2 or WebGPU';
}
```

## Pitfalls

- The container must have a size; the globe fills it and follows its size changes.
- `baseImageryUrl` is required, and `globe.ready` rejects with `resource-failed` when it fails to load.
- `imagery` and `terrain` need `workers`, or `createGlobe` throws `invalid-option`.
- The payloads of `frame`, `idle`, `camera-change` and `move` are reused objects: read them inside the handler.
- Importing the package touches no browser API; `createGlobe` runs in the browser only.

## Guides

The guides matching the installed version are in `node_modules/@vibeglobe/core/docs/guides/`, indexed by
`node_modules/@vibeglobe/core/llms.txt`. Start with
[integration](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/integration.md); the engine's
diagnostics are in [debugging](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/debugging.md).
