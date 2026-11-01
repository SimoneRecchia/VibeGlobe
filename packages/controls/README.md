# @vibeglobe/controls

Mouse, trackpad, touch and keyboard navigation for a VibeGlobe globe. `createControls` returns the factory that
`GlobeOptions.controls` takes, with commands for an application's own buttons (`zoomIn`, `resetNorth`, …), the
`'free'` and `'north-up'` navigation modes and the tilt policy. An application needs it for a globe the user moves;
`@vibeglobe/vue` and `@vibeglobe/web-component` create it themselves.

## Install

Needs `@vibeglobe/core` (a dependency).

## Entry points

| Import path           | What                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `@vibeglobe/controls` | `createControls`, `watchClicks`, `DEFAULT_CONTROLS_OPTIONS`, `DEFAULT_TILT_POLICY`, the option types |

## Example

```ts
import { createControls, watchClicks } from '@vibeglobe/controls';
import { createGlobe } from '@vibeglobe/core';

const controls = createControls({ navigationMode: 'north-up', tiltPolicy: true, gestures: { boxZoom: false } });
const globe = createGlobe({ container, renderer, controls, baseImageryUrl: '/vibeglobe/fallback-base.jpg' });
watchClicks(container, globe, ({ position }) => position && console.log(position.latitudeDeg));
```

## Pitfalls

- `createGlobe` attaches the controls to its canvas and connects them to the globe once the renderer starts; the
  commands do nothing before.
- While attached, the controls set `touch-action: none` on the canvas and make it focusable for the keyboard.
- HTML laid over the map takes the wheel: hand it to the map with `controls.forwardWheel(element)`.
- Invalid options throw a `GlobeError` (`invalid-option`).

## Guides

[Controls](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/controls.md) (gestures, keys, modes, tilt
policy, camera limits) and [UI and GIS](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/ui-and-gis.md)
(ready-made buttons).
