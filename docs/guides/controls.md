---
title: Navigation controls
---

# Navigation controls

`@vibeglobe/controls` turns mouse, trackpad, touch and keyboard input into camera movement: `createControls()` returns
the factory that `GlobeOptions.controls` takes, with commands for an application's buttons. The Vue component takes
the same options in its `controls` prop and the `<vibe-globe>` element creates default controls (see the
[integration guide](integration.md)). Ready-made buttons (zoom, compass, 2D / 3D / Auto, tilt slider) are in
`@vibeglobe/ui` ([UI and GIS guide](ui-and-gis.md)); camera movements from code are `Globe` methods (`flyTo`, …).

## Quick start

```ts
import { createControls } from '@vibeglobe/controls';
import { createGlobe } from '@vibeglobe/core';

declare const zoomInButton: HTMLButtonElement;
declare const zoomOutButton: HTMLButtonElement;

const controls = createControls();
createGlobe({ container, renderer, controls, baseImageryUrl: '/vibeglobe/fallback-base.jpg' });

zoomInButton.onclick = () => controls.zoomIn();
zoomOutButton.onclick = () => controls.zoomOut();
```

`createGlobe` attaches the controls to its canvas once the renderer starts and connects them to the globe
(`controls.connect`); the commands do nothing before. DOM handlers only record input; once per frame the engine asks
the controls to apply it, so many events between two frames cost one camera update. Inertia, the smoothed wheel zoom
and held keys run on the engine clock and follow the same path at any refresh rate.

| Command                              | Effect                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------- |
| `zoomIn()`, `zoomOut()`              | One level about the screen center, animated; calls add up               |
| `resetNorth()`                       | Turns to north up along the shorter arc                                 |
| `setNavigationMode(mode)`            | `'free'` or `'north-up'` (below)                                        |
| `setNorthUpMaxLatitude(deg)`         | The `'north-up'` latitude limit, 1 to 89.9                              |
| `setTiltPolicy(policy)`              | Turns the tilt policy on, changes it or turns it off                    |
| `onTiltAvailabilityChange(listener)` | Calls `listener(tiltAvailable)` on each change; returns the unsubscribe |
| `forwardWheel(element)`              | Lets the wheel zoom the map over an overlay element                     |

## Gestures

| Input                                   | Movement                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| Drag (primary button, one finger)       | Pans: the grabbed point stays under the pointer; released with speed, it glides   |
| Drag from the sky beside the globe      | Turns the globe about the screen center, like a trackball                         |
| Wheel                                   | Zooms at the cursor; a notch animates over 100 ms; over the sky, about the center |
| Trackpad scroll and pinch               | Zoom continuously at the cursor                                                   |
| Double click, double tap                | Zoom in one level at the point                                                    |
| Two-finger tap                          | Zooms out one level about the fingers' midpoint                                   |
| Shift+drag                              | Draws a zoom box; releasing it fits the box to the view; Escape cancels           |
| Right-drag, Ctrl+drag                   | Rotate (horizontal motion) and tilt (vertical motion) about the screen center     |
| Pinch, twist and two-finger drag        | Zoom, rotate and pan about the fingers' midpoint, together                        |
| Two fingers side by side, moved up/down | Tilts alone, when decided within 100 ms of the second finger                      |
| Safari trackpad gestures                | Pinch zooms, rotation turns the heading                                           |

A press, touch or key stops inertia where it is; a wheel zoom in progress completes about the point it started
at. Adding or lifting a finger continues the gesture without a jump. Right-drag opens no context menu.

Input over the map never scrolls or zooms the page: the controls take the wheel and set `touch-action: none` on the
canvas while attached. They also make it focusable (`tabindex="0"`) for the keyboard.

### Overlays over the map

HTML laid over the canvas (markers, labels, a panel) takes the wheel events over it, so the map does not zoom there.
`forwardWheel` hands them to the map:

```ts
import type { NavigationControls } from '@vibeglobe/controls';

declare const controls: NavigationControls;
declare const markers: HTMLElement;

const stop = controls.forwardWheel(markers); // the element and everything in it
stop(); // when the markers go
```

An event already handled (its default prevented) is left alone, so a container of both the map and its overlays works
too. Forwarded elements stay registered when the controls are attached again. Forward only elements whose own
scrolling is not needed: the page does not scroll over them.

### Clicks

`watchClicks` reports a press and release in place (primary button, under 4 px and 500 ms) with its position:

```ts
import { watchClicks } from '@vibeglobe/controls';
import type { Globe } from '@vibeglobe/core';

declare const globe: Globe;

const stop = watchClicks(container, globe, ({ point, position }) => {
  if (position) console.log(point.xPx, point.yPx, position.longitudeDeg, position.latitudeDeg);
});
```

`position` is undefined over the sky. The Vue component and the element emit the same payload as `globe-click`.

## Navigation modes

How a drag moves the camera: the `navigationMode` option at start, `setNavigationMode` at runtime.

| Mode               | A drag                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `'free'` (default) | Turns the globe like a trackball: it passes over the poles and the heading turns with the globe |
| `'north-up'`       | Keeps north up: horizontal motion turns about the polar axis, vertical motion changes latitude  |

- In `'free'` mode the flat map, at regional and street scale, keeps the heading during a drag.
- In `'north-up'` mode the point the camera looks at stops at `northUpMaxLatitudeDeg` (default 85, from 1 to 89.9):
  vertical motion beyond it is ignored and horizontal motion still turns the globe. A camera placed beyond the limit
  stays there.
- In both modes inertia, zoom to the cursor, the rotate and tilt gestures and `resetNorth` work the same, and a wheel
  zoom never turns the heading.

## Tilt policy

Without a policy the engine's Auto curves tilt the view near street level, and any tilt can be chosen at any distance.
The tilt policy ties the tilt to the distance from the eye to the point it looks at (the height above the ground when
looking straight down):

```ts
import { createControls } from '@vibeglobe/controls';

declare const button3d: HTMLButtonElement;

const controls = createControls({ tiltPolicy: true });
controls.setTiltPolicy({ lock2DAboveMeters: 100_000, fullTiltBelowMeters: 5_000 });
controls.onTiltAvailabilityChange((available) => (button3d.disabled = !available));
```

| Field                 | Default       | Effect                                                                          |
| --------------------- | ------------- | ------------------------------------------------------------------------------- |
| `lock2DAboveMeters`   | 20,000        | Beyond it the tilt is 0° and gestures, `jumpTo({ tiltDeg })` and 3D cannot tilt |
| `autoTiltBelowMeters` | 2,000         | Within it the tilt rises by itself, below the lock                              |
| `autoTiltMaxDeg`      | 60            | The automatic tilt, reached at a quarter of `autoTiltBelowMeters`               |
| `fullTiltBelowMeters` | half the lock | Where the cap on the tilt ends, below the lock                                  |

- From `lock2DAboveMeters` to `fullTiltBelowMeters` the largest allowed tilt rises continuously, in the distance's
  logarithm, from 0° to 90°; a far lock with a near end (100 km and 5 km) gives a view flat at a country's scale that
  tilts more and more while zooming in.
- A tilt chosen by hand below the lock stays until it is changed or the camera passes the lock; beyond the lock the
  view returns to Auto.
- A flight or fit that chooses a tilt keeps it until it ends, so one from afar into a tilted view arrives tilted.
- `tiltAvailable` is false beyond the lock. `ViewModeControl` and `addAllControls` of `@vibeglobe/ui` take the
  controls as their `tilt` option and disable 3D then; in Vue, `useTiltAvailable()` returns it as a ref.
- `setTiltPolicy(false)` or `setTiltPolicy(null)` turns the policy off.

### A tilt slider

`controls.maxTiltDeg` is the largest tilt of the last frame: the empty-sky limit, the constraints' `maxTiltDeg`, the
policy's cap, or the tilt the terrain clearance holds the camera at (90 before the controls are attached). Read it
when the camera changes:

```ts
import type { NavigationControls } from '@vibeglobe/controls';
import type { Globe } from '@vibeglobe/core';

declare const globe: Globe;
declare const controls: NavigationControls;
declare const slider: HTMLInputElement;

globe.on('camera-change', () => {
  slider.max = String(Math.round(controls.maxTiltDeg));
  slider.value = String(Math.round(globe.camera.tiltDeg));
});
slider.oninput = () => globe.jumpTo({ tiltDeg: Number(slider.value) });
```

## Camera limits

`globe.setConstraints(constraints)` holds every input and movement within limits (also `GlobeOptions.constraints`);
`globe.constraints` reads them back.

| Field                      | Range         | Effect                                                                        |
| -------------------------- | ------------- | ----------------------------------------------------------------------------- |
| `minZoom`, `maxZoom`       | 0 to 25       | Web Mercator zooms at the latitude of the view's center                       |
| `maxRangeMeters`           | 1 to 6 × 10⁷  | The farthest the eye may be from the point it looks at, at every latitude     |
| `maxTiltDeg`               | 0 to 89       | The largest tilt                                                              |
| `bounds`                   | a `GeoBounds` | Where the view's center may go; movements end inside                          |
| `minSurfaceDistanceMeters` | 0 to 10,000   | How near a zoom in brings the eye to the surface it zooms toward (default 40) |

- The same Web Mercator zoom is a nearer camera at high latitudes, so `minZoom` as a far limit moves the camera in
  while the view is dragged toward a pole. `maxRangeMeters` is the far limit that keeps the globe's size on screen.
- `minSurfaceDistanceMeters` measures to the terrain as drawn, mountains included, or to the ellipsoid without terrain;
  `0` removes the limit.

## Key map

Keys work while the map has focus (Tab reaches it, with a focus ring). Keys typed into other elements never move the
map, and keys with Ctrl, Alt or Meta are left to the browser.

| Key                     | Action                                                   |
| ----------------------- | -------------------------------------------------------- |
| Arrows                  | Pan while held, with an eased start and stop             |
| Shift+Left, Shift+Right | Rotate while held                                        |
| Shift+Up, Shift+Down    | Tilt while held                                          |
| `+` / `=`, `-`          | Zoom in / out one level about the center; presses add up |
| `N`                     | Turn to north up                                         |
| Home                    | Fly to the home view (`globe.goHome()`)                  |
| `2`, `3`, `A`           | 2D, 3D and Auto view modes                               |
| Escape                  | Cancel a zoom box                                        |

## Options

Every option is optional. The groups `inertia`, `wheel`, `keyboard` and `touch` take some of their fields, and
`DEFAULT_CONTROLS_OPTIONS` holds every default.

| Option                      | Type                                      | Default    | Effect                                                     |
| --------------------------- | ----------------------------------------- | ---------- | ---------------------------------------------------------- |
| `gestures`                  | `Partial<GestureSwitches>`                | all `true` | Switches single gestures off                               |
| `inertia`                   | `Partial<InertiaSettings>`                | per field  | Glide time constants and release-speed sampling            |
| `wheel`                     | `Partial<WheelSettings>`                  | per field  | Wheel and pinch pixels per level, notch smoothing          |
| `keyboard`                  | `Partial<KeyboardSettings>`               | per field  | Key pan, rotate and tilt speeds, levels per `+`/`-` press  |
| `touch`                     | `Partial<TouchSettings>`                  | per field  | Tap, double-tap, tilt, pinch and twist thresholds          |
| `rotateDegPerViewportWidth` | `number`                                  | 180        | Heading change of a rotate drag across the viewport        |
| `tiltDegPerViewportHeight`  | `number`                                  | 90         | Tilt change of a tilt drag across the viewport             |
| `maxTiltDeg`                | `number`                                  | 89         | The largest tilt input asks for, 0 to 89                   |
| `zoomAnimationMs`           | `number`                                  | 120        | Time constant of the zoom commands, double click, zoom box |
| `reducedMotion`             | `'system' \| 'reduce' \| 'no-preference'` | `'system'` | `'reduce'` shortens inertia to a quarter                   |
| `navigationMode`            | `'free' \| 'north-up'`                    | `'free'`   | How a drag moves the camera                                |
| `northUpMaxLatitudeDeg`     | `number`                                  | 85         | The `'north-up'` latitude limit, 1 to 89.9                 |
| `tiltPolicy`                | `boolean \| Partial<TiltPolicy>`          | off        | The tilt policy                                            |

Gesture switches: `dragPan`, `skyDragPan`, `wheelZoom`, `doubleClickZoom`, `boxZoom`, `dragRotate`, `touchZoom`,
`touchRotate`, `touchTilt`, `keyboard`, `inertia`.

## Rules and pitfalls

- `skyDragPan: false` makes a mouse or pen drag that starts on the sky do nothing until it is released, even once it
  reaches the globe; touch keeps it, because a finger beside the globe often starts a pinch.
- Reduced motion (the system's `prefers-reduced-motion: reduce`, followed at runtime, or `reducedMotion: 'reduce'`)
  shortens inertia to a quarter of its time constants.
- On a display too slow to show an animation (two animation frames in a row more than three time constants apart, as
  on software GPUs), wheel notches and the zoom commands apply in one step.
- A Shift-drag zoom box, the Home key and the view-mode keys use the connected globe; controls attached by other means
  than `createGlobe` need `controls.connect(globe)` for them.
- The engine's maximum tilt and the constraints may clamp a tilt further than `maxTiltDeg`.

## Errors

| Error or code                 | When                                                                           | What to do                       |
| ----------------------------- | ------------------------------------------------------------------------------ | -------------------------------- |
| `GlobeError` `invalid-option` | An unknown option or gesture, a value out of range, an unknown navigation mode | Fix the option the message names |
| `GlobeError` `invalid-option` | `setConstraints` with values out of range or `minZoom` above `maxZoom`         | Nothing changed; fix the values  |

## See also

- [UI and GIS](ui-and-gis.md): zoom, compass, 2D / 3D / Auto and tilt controls.
- [Integration](integration.md): the Vue `controls` prop and the element's `no-controls`.
- [Terrain](terrain.md): the camera above the ground.
