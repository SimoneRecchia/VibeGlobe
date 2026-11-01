---
title: Space background
---

# Space background

`addSpaceBackground` of `@vibeglobe/renderer/starfield` draws stars and the Milky Way behind the globe, with an
optional halo around it seen from space. It is off unless added, and `@vibeglobe/core` does not depend on it. The
atmosphere's day and night, which shape the same far view, are `Globe.setAtmosphere` settings, covered below.

## Quick start

```ts
import type { Globe } from '@vibeglobe/core';
import { addSpaceBackground } from '@vibeglobe/renderer/starfield';

declare const globe: Globe;

await globe.ready;
const space = addSpaceBackground(globe, { brightness: 1.2 });
space.setOptions({ milkyWay: false }); // shown from the next frame
space.setOptions({ visible: false }); // hidden, kept
space.remove(); // removed, its GPU resources freed
```

Call `addSpaceBackground` once the globe is ready: it adds a render extension, which needs the renderer. Its shaders
and the star catalog load when it is added, not before.

## Options

| Option       | Default        | Effect                                                                              |
| ------------ | -------------- | ----------------------------------------------------------------------------------- |
| `visible`    | `true`         | Shows the background; `false` hides it without removing it                          |
| `stars`      | `true`         | Draws the stars                                                                     |
| `milkyWay`   | `true`         | Draws the Milky Way                                                                 |
| `brightness` | `1`            | Multiplies the stars' light, 0 to 8                                                 |
| `timeMs`     | the engine's   | The sky's date and time (Unix ms, UTC); unset, it follows `Globe.atmosphere.timeMs` |
| `fade`       | `true`         | Fades the background out under the atmosphere's daytime sky near the ground         |
| `glow`       | `0`            | A halo around the globe seen from space, 0 to 4; 1 is a virtual globe's             |
| `catalogUrl` | next to module | Where the star catalog is hosted; only at creation                                  |

Every option but `catalogUrl` changes with `setOptions`; `timeMs: undefined` follows the engine again.
`space.options` reads them back, and `space.visibility` is the background's opacity in the last frame (0 to 1).

## How it moves and fades

- The stars are fixed in the celestial frame: the sky turns by precession and Greenwich mean sidereal time from the
  engine's time (`Globe.setAtmosphere({ timeMs })`, a fixed epoch until the application sets one), so every camera
  move turns the sky with the globe.
- The 9,096 stars of the Yale Bright Star Catalog are drawn as sprites at least 0.75 device pixels wide, equally bright
  at every pixel ratio and steady as they move. The Milky Way is computed in the shader.
- With the atmosphere on (`quality.atmosphere` not `'off'`) the background shows fully above 120 km and fades out
  toward the ground, gone below 20 km, unless it is night at the eye (sun lighting on, the Sun more than 10° below the
  horizon). With sun lighting off, the sky near the ground counts as day.
- A flat map seen from above 20 km hides the background as it morphs flat: a world map has no sky.
- `fade: false` keeps the background under the daytime sky; the flat map's fade still applies.

## A halo around the globe

The atmosphere's physical sky is a thin rim seen from space. `glow` adds the soft blue halo virtual globes draw
beyond the limb: a bright edge falling by e over 60 km and a wide part falling over 320 km, whitish at the edge and
deeper blue farther out. With sun lighting on it shows on the day side only; near the ground it fades with the rest of
the background.

Its widths are kilometres, so the nearer the camera, the more of the screen the halo fills. A page can fade it with
the range:

```ts
import type { Globe } from '@vibeglobe/core';
import { addSpaceBackground } from '@vibeglobe/renderer/starfield';

declare const globe: Globe;

const space = addSpaceBackground(globe, { milkyWay: false, glow: 1 });
let glow = 1;
globe.on('camera-change', ({ rangeMeters }) => {
  const next = Math.min(1, Math.max(0.15, (rangeMeters - 2_000_000) / 16_000_000)); // full at 18,000 km
  if (Math.abs(next - glow) < 0.02) return; // setOptions asks for a frame
  glow = next;
  space.setOptions({ glow });
});
```

## Day and night, and a clearer globe from afar

These are `AtmosphereSettings` of `Globe.setAtmosphere` (and `GlobeOptions.atmosphere`), not options of the
background.

- `dayNight` (0 to 1, default 0) dims the side away from the Sun at `timeMs` and tints it deep blue, across a soft
  terminator about 14° wide; the day side keeps the imagery's own colors. `sunLighting`, by contrast, also darkens the
  day side as the Sun gets low.
- An imagery layer with `blend: 'night'` shines on the night side only, added as light over the dimmed imagery: a
  city-lights image such as NASA's Black Marble (public domain; in Web Mercator from NASA GIBS as
  `VIIRS_Black_Marble`).
- `airlight` (0 to 1, default 1) scales the light the air scatters toward the eye over the ground. The physical amount
  veils the disk in milky blue from far away; around 0.5 the ground keeps deeper colors while the sky beyond the limb
  stays. A view like that needs no `glow`.

```ts
import type { Globe, ImagerySource } from '@vibeglobe/core';

declare const globe: Globe;
declare const nightLights: ImagerySource;

globe.imageryLayers.add({ id: 'night-lights', sources: [nightLights], blend: 'night', harmonize: false });
globe.setAtmosphere({ dayNight: 1, timeMs: Date.now() }); // update timeMs now and then: the terminator moves
```

To show day and night only from afar, animate `dayNight` over a few hundred milliseconds when the camera crosses the
limit (a fade in time, so the globe is never left half-dark at a resting zoom), and hide the night layer
(`visible: false`) once it reaches 0, so its tiles are not requested.

## Hosting its asset

The background has one asset, `bsc5-stars.bin` (54 KB), shipped at `@vibeglobe/renderer/src/starfield/bsc5-stars.bin`.
The module refers to it with `new URL(…, import.meta.url)`, so bundlers such as Vite copy it to the application's
assets. To host it elsewhere on your own origin ([hosting guide](hosting.md)), copy the file and pass its URL:

```ts
import type { Globe } from '@vibeglobe/core';
import { addSpaceBackground } from '@vibeglobe/renderer/starfield';

declare const globe: Globe;

addSpaceBackground(globe, { catalogUrl: '/engine-assets/bsc5-stars.bin' });
```

The catalog is the Yale Bright Star Catalog (public domain), converted to JSON by Bretton Wade under the MIT License,
recorded in
[`THIRD_PARTY_NOTICES.md`](https://github.com/SimoneRecchia/VibeGlobe/blob/main/THIRD_PARTY_NOTICES.md).

## Rules and pitfalls

- `addSpaceBackground` before `globe.ready` throws a `GlobeError`: `Globe.addRenderExtension` needs the renderer.
- Without the atmosphere (`quality.atmosphere: 'off'`) nothing hides the background near the ground, and a
  `blend: 'night'` layer draws nothing.
- Day and night shade the imagery only: vector tile layers (a map's water and fills) are not shaded, so use it over
  imagery.

## Errors

| Error or code                    | When                                                              | What to do                     |
| -------------------------------- | ----------------------------------------------------------------- | ------------------------------ |
| `GlobeError` `invalid-option`    | `brightness` outside 0–8, `glow` outside 0–4, `timeMs` not finite | Fix the value                  |
| `error` event, `resource-failed` | The star catalog fails to load from `catalogUrl`                  | Check the file is served there |

## See also

- [Sources](sources.md): NASA GIBS and other imagery for a night layer.
- [Hosting](hosting.md): serving the engine's assets.
