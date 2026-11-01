---
title: UI controls and GIS utilities
---

# UI controls and GIS utilities

The engine runs without any UI. `@vibeglobe/ui` adds ready-made controls over a globe (`createUi`), styled by CSS
variables and translated; `@vibeglobe/ui/minimap` holds the overview minimap. `@vibeglobe/gis` holds the pure
functions behind them, usable without the renderer or the UI: coordinate formats and parsing, reference-system
transforms, geodesic measurement, view state in URLs, and the layout and detection of panels in rows. Mouse, touch
and keyboard navigation is in the [controls guide](controls.md); in Vue, add a control with `<VibeControl>`
([integration guide](integration.md#vue-3)).

## Quick start

```ts
import type { Globe } from '@vibeglobe/core';
import { addDefaultControls, createUi, ZoomControl } from '@vibeglobe/ui';

declare const globe: Globe;

const ui = createUi(globe, container, { theme: 'light', language: 'en' });
addDefaultControls(ui); // search, zoom, compass, fullscreen, coordinates readout
ui.remove('fullscreen');
ui.replace(new ZoomControl({ step: 2 }));
ui.setTheme('dark');
ui.setLanguage('it');
```

`createUi` lays the `.vg-ui` layer over `container`, the element the globe fills, with one area per corner.
`addAllControls(ui, { tilt: controls })` adds every navigation control instead; the tools are added one by one.

## Built-in controls

Each control is a class taking an options object with `id` and `position`; `ui.add`, `ui.remove(id)`,
`ui.replace(control)` and `ui.get(id)` work by id.

| Class                      | Id            | Corner       | What it is                                                        |
| -------------------------- | ------------- | ------------ | ----------------------------------------------------------------- |
| `SearchControl`            | `search`      | top-left     | Typed coordinates, and places from the application's `geocoder`   |
| `ZoomControl`              | `zoom`        | top-right    | Zoom in and out by animated steps                                 |
| `CompassControl`           | `compass`     | top-right    | Shows north; click turns north up, drag rotates                   |
| `FullscreenControl`        | `fullscreen`  | top-right    | The map container in and out of fullscreen                        |
| `CoordinateReadoutControl` | `readout`     | bottom-left  | Position and elevation under the pointer: decimal, DMS or UTM     |
| `ViewModeControl`          | `view-mode`   | top-right    | 2D / 3D / Auto; its `tilt` option disables 3D under a tilt policy |
| `TiltControl`              | `tilt`        | top-right    | A tilt slider (`globe.tiltTo`)                                    |
| `HomeControl`              | `home`        | top-right    | Whole globe (`resetToGlobe`) and home view (`goHome`) buttons     |
| `GeolocationControl`       | `geolocation` | top-right    | The device's position with its accuracy circle                    |
| `LayerSwitcherControl`     | `layers`      | top-right    | Base maps, imagery overlays and data layers                       |
| `ScaleBarControl`          | `scale`       | bottom-left  | A round ground length at the view center                          |
| `AttributionControl`       | `attribution` | bottom-right | The credits of the sources in view                                |
| `DebugToggleControl`       | `debug`       | bottom-left  | Frame time and engine counters ([debugging guide](debugging.md))  |
| `DrawControl`              | `draw`        | top-left     | Points, lines and polygons, with editing                          |
| `MeasureControl`           | `measure`     | top-left     | Distance and area on the WGS84 ellipsoid                          |
| `BookmarksControl`         | `bookmarks`   | top-left     | Saved views, kept in `localStorage` with `storageKey`             |
| `ScreenshotControl`        | `screenshot`  | top-right    | Downloads the view as a PNG with its credits                      |
| `MinimapControl`           | `minimap`     | bottom-right | A world image (`imageUrl`) with the view's footprint              |

- `addDefaultControls` adds search, zoom, compass, fullscreen and the readout; `debug: true` adds the debug toggle.
- `addAllControls` adds search and the 2D / 3D / Auto toggle (top left), zoom, compass, tilt, home, geolocation, layers
  and fullscreen (top right), the readout and the scale bar (bottom left) and attribution (bottom right).
- Both take `geocoder` and `debug`; `addAllControls` also takes `layers` (the layer switcher's options) and `tilt`.
- `MinimapControl` is imported from `@vibeglobe/ui/minimap`, so an application without it never loads it.
- The search box makes no request without a `geocoder`: the application supplies one implementing `Geocoder`
  (`search(query, { signal, language })` resolving `GeocoderResult[]`).

### Your own controls

A control implements `UiControl`: `id`, `position`, `mount(context)` returning its element, `destroy()`, and
optionally `localize()`. `context` gives the globe (its public API), the map container, the translator (`i18n`),
`reducedMotion()` and `layers()`, the data-layer stack the drawing controls share. Built-in controls can also be
extended by subclassing.

```ts
import type { ControlContext, UiControl } from '@vibeglobe/ui';

class NorthUpButton implements UiControl {
  readonly id = 'north-up';
  readonly position = 'top-right' as const;
  #button: HTMLButtonElement | undefined;

  mount({ globe }: ControlContext): HTMLElement {
    this.#button = document.createElement('button');
    this.#button.textContent = 'N';
    this.#button.onclick = () => void globe.rotateTo(0);
    return this.#button;
  }

  destroy(): void {
    this.#button = undefined;
  }
}
```

## Keyboard

| Control                 | Keys                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------- |
| Every button            | Tab and Shift+Tab move between controls; Enter or Space activates                     |
| Zoom                    | Enter or Space on + or − zooms one level; presses during a step chain from its target |
| Compass                 | Enter or Space face north; arrows rotate by 15° (`keyStepDeg`); N, E, S, W face there |
| Fullscreen, debug panel | Enter or Space toggles; the state is in `aria-pressed`                                |
| Coordinates readout     | Its button or F switches the format; keys on the map show the view center             |
| Search                  | Up and Down move through the results; Enter goes there; Escape clears                 |

## Theming

The controls are styled only through CSS variables. Set them on the `.vg-ui` element (`ui.element`), inline or in a
rule of the page (`.vg-ui { --vg-ui-color: #222; }`): the defaults sit in the `vibeglobe-ui-theme` cascade layer, so a
page rule wins in either theme. Values set on an ancestor do not reach the controls, because `.vg-ui` declares every
variable itself. `THEME_VARIABLES` holds every variable with its value in the `light` and `dark` themes; both meet WCAG
2.1 AA contrast.

| Variables                                                                    | What they style                             |
| ---------------------------------------------------------------------------- | ------------------------------------------- |
| `--vg-ui-font-family`, `--vg-ui-font-size`, `--vg-ui-monospace-font-family`  | Text; figures of the debug panel            |
| `--vg-ui-color`, `--vg-ui-muted-color`                                       | Text and icons; labels and hints            |
| `--vg-ui-background`, `--vg-ui-hover-background`                             | Controls and panels; hovered or pressed     |
| `--vg-ui-border-color`, `--vg-ui-border-width`, `--vg-ui-border-radius`      | Borders                                     |
| `--vg-ui-accent-color`                                                       | The compass's north needle and highlights   |
| `--vg-ui-focus-color`, `--vg-ui-focus-width`                                 | The keyboard focus ring                     |
| `--vg-ui-button-size`, `--vg-ui-touch-size`, `--vg-ui-icon-size`             | Button sides (touch screens: at least 44px) |
| `--vg-ui-spacing`, `--vg-ui-panel-width`, `--vg-ui-shadow`                   | Gaps and edges, panel width, shadow         |
| `--vg-ui-disabled-opacity`, `--vg-ui-transition-duration`                    | Disabled controls; transitions (0s reduced) |
| `--vg-ui-debug-color`, `--vg-ui-debug-background`, `--vg-ui-debug-font-size` | The debug panel                             |
| `--vg-ui-logo-height`, `--vg-ui-logo-clear`, `--vg-ui-logo-clear-bottom`     | Provider logos in the attribution           |
| `--vg-ui-marker-color`, `--vg-ui-marker-outline-color`                       | The geolocation marker on the map           |
| `--vg-ui-drawing-color`, `--vg-ui-drawing-handle-color`                      | Drawn and measured shapes, their handles    |
| `--vg-ui-minimap-footprint-color`                                            | The minimap's footprint                     |

The colors of what controls draw on the map are read when a control creates its map layers (the drawing tools when
added, the geolocation marker when first shown; the minimap on every update): set them before adding the control.

## Translations

English (`en`) and Italian (`it`) are built in. `ui.i18n.registerLanguage('de', { 'zoom.in': 'Vergrößern' })` adds a
language whose missing keys fall back to English; `ui.i18n.overrideStrings('en', { 'zoom.out': 'Smaller' })` replaces
single strings. `ui.setLanguage` throws a `RangeError` for a language not registered. Numbers follow the language's
format.

## Drawing with your own toolbar

`DrawControl` and `MeasureControl` are toolbars over three exported classes, which an application with its own
toolbar drives directly: `DrawingTool` holds the shapes and the mode, `DrawLayers` shows them as data layers in the
given colors, and `DrawInput` turns pointer, touch and keyboard input on the map container into the tool's commands.

```ts
import type { Globe } from '@vibeglobe/core';
import * as layersModule from '@vibeglobe/layers';
import { DrawingTool, DrawInput, DrawLayers } from '@vibeglobe/ui';

declare const globe: Globe;
declare const cursor: HTMLElement; // the keyboard cursor, positioned over the map by DrawInput

await globe.ready;
const tool = new DrawingTool();
tool.attach(
  new DrawLayers(layersModule.createGlobeLayers(globe, { element: container }), layersModule, 'draw', {
    shape: '#d93025',
    handle: '#ffffff',
  }),
);
const input = new DrawInput(globe, container, tool, cursor, () => undefined);
tool.setMode('polygon'); // 'point', 'line', 'polygon', 'edit' or 'none'
tool.on('create', ({ feature }) => console.log(JSON.stringify(feature)));
input.destroy(); // when the toolbar goes
```

Events: `create`, `change`, `delete`, `draft` (the shape being drawn), `mode` and `validation` (a polygon that would
cross itself). `tool.features()` returns the shapes as GeoJSON features.

## View state in a URL

```ts
import type { Globe } from '@vibeglobe/core';
import { viewStateFromUrl, viewStateOf, viewStateToUrl } from '@vibeglobe/gis';
import { applyViewState } from '@vibeglobe/ui';

declare const globe: Globe;

const saved = viewStateFromUrl(location.href);
if (saved) applyViewState(globe, saved); // a jump; { movement: 'fly' } flies
globe.on('moveend', () => {
  const view = viewStateOf(globe.camera);
  if (view) history.replaceState(null, '', viewStateToUrl(location.href, view));
});
```

The view sits in the fragment as `#view=zoom/latitude/longitude/heading/tilt/mode[/chosenTilt[/chosenHeading]]`,
exact to the last bit, next to the fragment's other parameters. `viewStateToJson` and `viewStateFromJson` write and
read it as JSON. Readers return undefined for malformed input and clamp or wrap values out of range.

## GIS utilities

```ts
import { formatCoordinate, measureDistance, parseCoordinate, transformCoordinates } from '@vibeglobe/gis';

const milan = { longitudeDeg: 9.19, latitudeDeg: 45.4642 };
const rome = { longitudeDeg: 12.4964, latitudeDeg: 41.9028 };
formatCoordinate(milan, 'dms'); // '45°27′51.1″N 9°11′24.0″E'
formatCoordinate(milan, 'utm'); // '32T 514853 5034537'
parseCoordinate('32T 514853 5034537'); // { longitudeDeg: 9.189993…, latitudeDeg: 45.464201… }
transformCoordinates({ x: 9.19, y: 45.4642 }, 'EPSG:4326', 'EPSG:32632'); // { x: 514853.49…, y: 5034536.79… }
measureDistance(milan, rome).distanceMeters; // 477025.46…, Karney's geodesics on WGS84
```

| Function                                               | What it does                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| `formatCoordinate(position, format, options)`          | `'decimal'` (5 places), `'dms'` (1 place of seconds) or `'utm'` (metres) |
| `parseCoordinate(text)`, `parseCoordinateResult(text)` | Reads decimal, DMS and UTM text; the second says why a text is refused   |
| `toUtm`, `fromUtm`, `utmZone`, `utmBand`               | WGS84 UTM                                                                |
| `transformCoordinates(point, from, to)`, `defineCrs`   | Transforms through proj4js; `defineCrs(code, projOrWkt)` adds a system   |
| `measureDistance`, `measurePathLength`, `measureArea`  | Geodesic distance and bearings, path length, polygon area and perimeter  |
| `formatLength`, `formatArea`                           | `850 m`, `1.23 km`, in a locale's number format                          |

Built-in reference systems: EPSG:4326, EPSG:3857, EPSG:4258 (ETRS89), EPSG:25832, EPSG:25833, and every WGS84 UTM zone
(EPSG:326zz north, EPSG:327zz south); `crsCodes()` lists them with those defined. `formatCoordinate` returns undefined
for UTM outside 80°S to 84°N.

## Panels in rows

Three functions serve an editor of identical rectangles in rows, such as the tables of a solar park.

`layoutPanels` places `count` panels of `widthM` × `depthM` metres in rows inside one or more perimeters:

- Rows run along `rowBearingDeg` (default 90: east–west), `gapM` (default 0.5) apart in a row and `rowGapM` (default
  the panel's depth) between rows; they fill from the far side, each from its start.
- A panel with a `wanted` position takes the free place nearest to it; the others take the next free places, so a list
  ordered by group stays together. Giving every panel its current place as `wanted` snaps them back onto even rows.
- `fixed` panels keep their places and the rest go around them. `anchor` lines the rows up with one panel (seen in an
  image, or already placed); without it the rows take the phase that holds the most panels.
- `moving` lists, by index, the panels dragged by hand: each takes the place nearest where it is dropped and the panels
  in the way shift along the rows toward the nearest free place, in order.
- When the perimeters cannot hold every panel, all shrink alike down to `minScale` (default 0.85); the result's `scale`
  says how much. Panels still without a place are undefined, or line up beyond the last row with `spill: true`.

```ts
import { gridLines, layoutPanels } from '@vibeglobe/gis';

const corner = { longitudeDeg: 13.0, latitudeDeg: 52.3 };
const field = [
  corner,
  { longitudeDeg: 13.004, latitudeDeg: 52.3 },
  { longitudeDeg: 13.004, latitudeDeg: 52.302 },
  { longitudeDeg: 13.0, latitudeDeg: 52.302 },
];
const { centers, scale } = layoutPanels({ perimeters: [field], count: 120, widthM: 13.6, depthM: 4.6 });
const lines = gridLines({ center: corner, halfSizeM: 400, spacingM: 10 }); // segments for a line layer
```

`gridLines` returns the segments of a square grid on the ground, each as its two ends, turned to `bearingDeg`
(default 0). It returns at most 2000 lines: a finer grid over a larger square has its spacing doubled until it fits.

`detectPanels` finds the tables already built in a top-down image of the area, with image arithmetic and no trained
model: blue pixels (or, for black modules, pixels darker than the ground; never green or warm tones) are panels.
It returns the rows' bearing, the row pitch, a table's size and every table's center inside the perimeters, or
undefined when no rows stand out. The image must look straight down, north up, with its edges in degrees:

```ts
import type { Globe } from '@vibeglobe/core';
import { detectPanels } from '@vibeglobe/gis';

declare const globe: Globe;
declare const field: { longitudeDeg: number; latitudeDeg: number }[];
declare const bounds: { westDeg: number; eastDeg: number; southDeg: number; northDeg: number };

const view = await globe.captureView({ widthPx: 1600, heightPx: 1000 });
const found = detectPanels({
  image: { data: view.rgba, width: view.widthPx, height: view.heightPx },
  bounds,
  perimeters: [field],
});
```

## Rules and pitfalls

- `container` must be positioned (not `position: static`): the `.vg-ui` layer covers it with `position: absolute`.
  The Vue component's and the element's containers are.
- `ui.add` throws when a control's id is taken: `ui.replace` swaps a control for one with the same id.
- `captureView` covers the image with the view: an image of another aspect ratio than the canvas crops the view's
  sides, or its top and bottom. Capture at the canvas's ratio when the image's edges must be the canvas's corners
  (`globe.screenToGeo` at the corners gives them, at a near zoom looking straight down).
- `captureView` rejects with `display-only` while a source whose terms forbid reading pixels is drawn.
- `transformCoordinates` and `formatCoordinate` throw a `RangeError` for an unknown code, a latitude outside ±90° or a
  non-finite value.

## See also

- [Controls](controls.md): gestures, keys, the tilt policy and camera limits.
- [Data layers](data-layers.md): the layers the drawing tools and the layer switcher use.
- [Integration](integration.md): `<VibeControl>` in Vue and the element's `ui` attribute.
