---
title: UI controls and GIS utilities
---

# UI controls and GIS utilities

The engine runs without any UI. `@vibeglobe/ui` adds ready-made controls on top of a globe, and `@vibeglobe/gis` holds the coordinate, reference-system, measurement and view-state functions those controls use, which applications can call directly.

## Adding controls

```ts
import { addDefaultControls, createUi, ZoomControl } from '@vibeglobe/ui';

const ui = createUi(globe, container, { theme: 'light', language: 'en' });
addDefaultControls(ui, { debug: false }); // search, zoom, compass, fullscreen, coordinates readout
ui.remove('fullscreen');
ui.replace(new ZoomControl({ step: 2 }));
ui.setTheme('dark');
ui.setLanguage('it');
```

The overview minimap has an entry point of its own, so applications without it do not load it: `import { MinimapControl } from '@vibeglobe/ui/minimap'`.

Every control implements `UiControl` (`id`, `position`, `mount(context)`, `localize()`, `destroy()`). An application's own control implements the same interface and receives the globe (public API only), the map container and the translator; built-in controls can be extended by subclassing.

## Keyboard

| Control                 | Keys                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| Every button            | Tab and Shift+Tab move between controls; Enter or Space activates                                       |
| Zoom                    | Enter or Space on + or − zooms one level; presses during a step chain from its target                   |
| Compass                 | Enter or Space turns to north; arrow keys rotate by 15°; N, E, S and W face that direction in one step  |
| Fullscreen, debug panel | Enter or Space toggles; the state is announced through `aria-pressed`                                   |
| Coordinates readout     | Enter or Space on its button switches decimal degrees → DMS → UTM; keys on the map show the view center |
| Search                  | Type a place or coordinates; Up and Down move through the results; Enter goes there; Escape clears      |

## Theming

The controls are styled only through CSS variables, so an application restyles them without touching internal selectors. Set them on the `.vg-ui` element (`ui.element`), inline or in a rule of the page's stylesheet (`.vg-ui { --vg-ui-color: #222; }`): the defaults sit in the `vibeglobe-ui-theme` cascade layer, so a page rule wins in either theme. (Values set on an ancestor do not reach the controls: `.vg-ui` declares every variable itself.)

| Variable                                                                                                       | Light default                      | Dark default       |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------ |
| `--vg-ui-font-family`, `--vg-ui-font-size`                                                                     | system UI font, 13px               | same               |
| `--vg-ui-monospace-font-family`                                                                                | monospace stack (debug panel)      | same               |
| `--vg-ui-color`, `--vg-ui-muted-color`                                                                         | #1b1f24, #4d5560                   | #f1f3f7, #b9c0cc   |
| `--vg-ui-background`, `--vg-ui-hover-background`                                                               | #ffffff, #e6e9ee                   | #1f232b, #323844   |
| `--vg-ui-border-color`, `--vg-ui-border-width`, `--vg-ui-border-radius`                                        | #6b7380, 1px, 6px                  | #8d95a3, 1px, 6px  |
| `--vg-ui-accent-color` (compass north)                                                                         | #b3261e                            | #f28b82            |
| `--vg-ui-focus-color`, `--vg-ui-focus-width`                                                                   | #0b57d0, 3px                       | #8ab4f8, 3px       |
| `--vg-ui-button-size`, `--vg-ui-touch-size`, `--vg-ui-icon-size`                                               | 36px, 44px (coarse pointers), 20px | same               |
| `--vg-ui-spacing`, `--vg-ui-panel-width`                                                                       | 8px, 280px                         | same               |
| `--vg-ui-shadow`, `--vg-ui-disabled-opacity`                                                                   | soft shadow, 0.4                   | darker shadow, 0.4 |
| `--vg-ui-transition-duration`                                                                                  | 150ms (0s with reduced motion)     | same               |
| `--vg-ui-debug-color`, `--vg-ui-debug-background`, `--vg-ui-debug-font-size`                                   | white on 75% black, 12px           | same               |
| `--vg-ui-marker-color`, `--vg-ui-marker-outline-color` (geolocation marker; read when it is drawn)             | #1a73e8, white                     | same               |
| `--vg-ui-drawing-color`, `--vg-ui-drawing-handle-color` (drawn and measured shapes; read when a tool is added) | #d93025, white                     | same               |
| `--vg-ui-minimap-footprint-color` (read on each minimap update)                                                | #ff4040                            | same               |

The colours of what controls draw on the map are read when a control creates its map layers (the drawing tools when added, the geolocation marker when first shown), the minimap's on every update: set them before adding the control.

`THEME_VARIABLES` exports the exact values. Both built-in themes meet WCAG 2.1 AA contrast.

## Translations

English and Italian are built in. `ui.i18n.registerLanguage('de', { 'zoom.in': 'Vergrößern' })` adds a language (missing keys fall back to English), and `ui.i18n.overrideStrings('en', { 'zoom.out': 'Smaller' })` replaces single strings. Numbers follow the language's format.

## GIS utilities

```ts
import {
  formatCoordinate,
  parseCoordinate,
  transformCoordinates,
  measureDistance,
  viewStateToUrl,
} from '@vibeglobe/gis';

formatCoordinate({ longitudeDeg: 9.19, latitudeDeg: 45.4642 }, 'dms'); // '45°27′51.1″N 9°11′24.0″E'
parseCoordinate('32T 514853 5034538'); // { longitudeDeg: 9.19…, latitudeDeg: 45.464… }
transformCoordinates({ x: 9.19, y: 45.4642 }, 'EPSG:4326', 'EPSG:32632'); // UTM 32N
measureDistance(milan, rome).distanceMeters; // Karney's geodesics on WGS84
```

Built-in reference systems: EPSG:4326, EPSG:3857, EPSG:32632, EPSG:32633, EPSG:4258 (ETRS89), EPSG:25832, EPSG:25833 and every WGS84 UTM zone (EPSG:326zz, EPSG:327zz); `defineCrs(code, projString)` adds others. Transforms run through proj4js (MIT).
