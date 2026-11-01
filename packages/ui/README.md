# @vibeglobe/ui

Ready-made controls over a VibeGlobe globe: search, zoom, compass, 2D / 3D / Auto, tilt, home, geolocation, layer
switcher, coordinates readout, scale bar, attribution, drawing, measurement, bookmarks, screenshot, minimap and a debug
panel. `createUi` places them in the map's corners; they are themed by CSS variables, translated (English and Italian
built in) and keyboard accessible. An application needs it when it wants these controls instead of its own; the engine
runs without it.

## Install

Needs `@vibeglobe/core`, `@vibeglobe/gis` and `@vibeglobe/layers` (dependencies).

## Entry points

| Import path             | What                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `@vibeglobe/ui`         | `createUi`, `addDefaultControls`, `addAllControls`, every control class, the drawing tool, `THEME_VARIABLES` |
| `@vibeglobe/ui/minimap` | `MinimapControl`, kept apart so applications without it never load it                                        |

## Example

```ts
import type { Globe } from '@vibeglobe/core';
import { addAllControls, createUi, ScaleBarControl } from '@vibeglobe/ui';

declare const globe: Globe;

const ui = createUi(globe, container, { theme: 'dark', language: 'it' });
addAllControls(ui);
ui.replace(new ScaleBarControl({ position: 'bottom-right' }));
ui.element.style.setProperty('--vg-ui-accent-color', '#ff6d00');
```

## Pitfalls

- The container must be positioned (not `position: static`).
- `ui.add` throws when an id is taken; `ui.replace` swaps a control for one with the same id.
- The colors of what controls draw on the map are read when the control creates its layers: set them before adding it.
- The search box bundles no geocoder and makes no request without the application's `geocoder`.
- With `AttributionControl`, `GlobeOptions.creditsElement: false` leaves the credits to it alone.

## Guides

[UI and GIS](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/ui-and-gis.md),
[controls](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/controls.md) and
[debugging](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/debugging.md).
