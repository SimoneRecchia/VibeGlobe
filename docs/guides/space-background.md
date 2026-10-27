---
title: Space background
---

# Space background

An optional background of stars and the Milky Way behind the globe, like a virtual globe's, off by default (ADR 0181).
It is a render extension of `@vibeglobe/renderer`; `@vibeglobe/core` does not depend on it.

```ts
import { addSpaceBackground } from '@vibeglobe/renderer/starfield';

await globe.ready;
const space = addSpaceBackground(globe, { brightness: 1.2 });
space.setOptions({ milkyWay: false }); // shown from the next frame
space.setOptions({ visible: false }); // hidden, kept
space.remove(); // removed, its GPU resources freed
```

## Enabling it

Call `addSpaceBackground(globe, options)` once the globe is ready (`Globe.addRenderExtension` needs the renderer). Nothing
of it is loaded before: the module, three.js's shaders for it and the star catalog are requested when it is added. In
the playground, `?stars=1` switches it on (`&starCatalog=<url>` hosts the catalog elsewhere).

## Options

| Option       | Default        | What it does                                                                        |
| ------------ | -------------- | ----------------------------------------------------------------------------------- |
| `visible`    | `true`         | Shows the background; `false` hides it without removing it                          |
| `stars`      | `true`         | Draws the stars                                                                     |
| `milkyWay`   | `true`         | Draws the Milky Way                                                                 |
| `brightness` | `1`            | Multiplies the stars' light, 0 to 8                                                 |
| `timeMs`     | the engine's   | The sky's date and time (Unix ms, UTC); unset, it follows `Globe.atmosphere.timeMs` |
| `fade`       | `true`         | Fades the background out under the atmosphere's daytime sky near the ground         |
| `catalogUrl` | next to module | Where the star catalog is hosted (only at creation, see below)                      |

Every option but `catalogUrl` can change later with `setOptions`; `timeMs: undefined` follows the engine again. Invalid
values throw a `GlobeError` with code `invalid-option`; a catalog that fails to load is reported through the globe's
`error` event (`resource-failed`).

## How it moves and fades

The stars are fixed in the celestial frame: the sky turns by Greenwich sidereal time and precession from the engine's
date and time (`Globe.setAtmosphere({ timeMs })`, a fixed epoch until the application sets one), so every camera move,
globe spin or tilt turns the sky with the globe. Stars are drawn as sprites never smaller than 0.75 device pixels, equally
bright at every pixel ratio and steady as they move. With the atmosphere on, the background shows from space and at
night and fades out under the daytime sky below 20 km; on a flat map seen from high above it fades out too.

## Hosting its asset

The background has one asset, `bsc5-stars.bin` (54 KB): the 9,096 stars of the Yale Bright Star Catalog (public domain;
converted to JSON by Bretton Wade under the MIT License, recorded in `THIRD_PARTY_NOTICES.md`). It ships in the
package at `@vibeglobe/renderer/src/starfield/bsc5-stars.bin`, and the module refers to it with
`new URL(…, import.meta.url)`, so bundlers such as Vite copy it to the application's assets by themselves. To host it
elsewhere on your own origin, as the [hosting guide](hosting.md) describes for the other engine assets, copy the file and
pass its URL:

```ts
addSpaceBackground(globe, { catalogUrl: '/engine-assets/bsc5-stars.bin' });
```

The Milky Way is computed in the shader: there is no image to host.
