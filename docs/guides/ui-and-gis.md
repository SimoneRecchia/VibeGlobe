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

An application with a toolbar of its own drives the drawing tool directly (F660): `DrawingTool` holds the shapes and the
mode, `DrawLayers` shows them as data layers in the colors it is given, and `DrawInput` turns pointer, touch and
keyboard input on the map container into the tool's commands. The application's buttons call `tool.setMode('polygon')`,
`'edit'` or `'none'` and listen to `tool.on('create' | 'change' | 'delete', …)`.

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

### Panels in rows, and a grid on the ground

`layoutPanels` places identical rectangles, such as the tables of a solar park, in rows inside one or more perimeters
(F658). Rows run along `rowBearingDeg` and fill from the far side; panels with a `wanted` position (a known real place)
take the free place nearest to it, the others the next free places, so a list ordered by group (an inverter's tables)
stays together. `fixed` panels (locked, or being dragged) keep their places and the rest go around them. When the
perimeters cannot hold every panel at its size, all shrink alike down to `minScale` (default 0.85); panels that still
find no place come back undefined. A scanline over each row keeps it fast enough to run on every move of a panel.

```ts
import { gridLines, layoutPanels } from '@vibeglobe/gis';

const field = [
  { longitudeDeg: 13.0, latitudeDeg: 52.3 },
  { longitudeDeg: 13.004, latitudeDeg: 52.3 },
  { longitudeDeg: 13.004, latitudeDeg: 52.302 },
  { longitudeDeg: 13.0, latitudeDeg: 52.302 },
];
const { centers, scale } = layoutPanels({ perimeters: [field], count: 120, widthM: 13.6, depthM: 4.6 });
// A backdrop grid of 10 m around it: segments to draw as a line layer.
const lines = gridLines({ center: field[0], halfSizeM: 400, spacingM: 10 });
```

`gridLines` (F659) returns the segments of a square grid on the ground, turned to a bearing, at most 2000 of them.

`detectPanels` (F664) finds the tables already built in a top-down image of the area, with image arithmetic and no
trained model: the pixels darker than the ground around them (green excluded) are panels, the bearing across which
they pile into the sharpest stripes is the rows', the stripes are the rows and the dark runs along each row its
tables, cut to `widthM` when given and otherwise to the length of the lone tables seen. Pass a capture of the view
looking straight down, north up (`globe.captureView`) with its edges in degrees; it returns the rows' bearing,
spacing, a table's size and every table's center inside the perimeters, or undefined when nothing stands out. About
a tenth of a second for two million pixels.

```ts
const view = await globe.captureView({ widthPx: 1600, heightPx: 1000 });
const found = detectPanels({ image: view, bounds, perimeters: [field] });
```
