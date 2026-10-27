---
title: Navigation controls
---

# Navigation controls

`@vibeglobe/controls` turns mouse, trackpad, touch and keyboard input into camera movement. DOM handlers only record input; once per frame the engine asks the controls to turn it into camera intents (ADR 0009), so many events between two frames cost one camera update. Every movement is time-based: inertia, the smoothed wheel zoom and held keys follow the same path at any refresh rate.

```ts
import { createControls } from '@vibeglobe/controls';
import { createGlobe } from '@vibeglobe/core';

const controls = createControls();
const globe = createGlobe({ container, renderer, controls, baseImageryUrl });
// Rotation, tilt and the engine clock need the globe until the engine's navigation interface carries them.
controls.connect(globe);

zoomInButton.onclick = () => controls.zoomIn();
zoomOutButton.onclick = () => controls.zoomOut();
```

Without `connect`, pan and zoom work and the rotate and tilt gestures are off.

## Gestures

| Input                                   | Movement                                                                                           |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Drag (primary button, one finger)       | Pans; the grabbed point stays under the pointer. Released with speed, it coasts and slows to rest. |
| Wheel                                   | Zooms at the cursor; a notch animates over about 100 ms. Over empty sky it zooms about the center. |
| Trackpad scroll and pinch               | Zoom continuously at the cursor, in proportion to the fingers' motion.                             |
| Double click, double tap                | Zoom in one level at the point.                                                                    |
| Two-finger tap                          | Zooms out one level about the fingers' midpoint.                                                   |
| Shift+drag                              | Draws a zoom box; releasing it fits the box to the view. Escape cancels.                           |
| Right-drag, Ctrl+drag                   | Rotate (horizontal motion) and tilt (vertical motion) about the screen center. No context menu.    |
| Pinch, twist and two-finger drag        | Zoom, rotate and pan about the fingers' midpoint, together; each starts past a small threshold.    |
| Two fingers side by side, moved up/down | Tilts, on its own (decided within the first 100 ms).                                               |
| Adding or lifting a finger              | The gesture continues from where it is, without a jump.                                            |
| Safari trackpad gestures                | Pinch zooms and rotation turns the heading.                                                        |

A new press, touch or key stops inertia and running turns where they are; a wheel zoom still in progress completes, about the point it started at.

Input over the map never scrolls or zooms the page: the map takes wheel events and sets `touch-action: none` while the controls are attached. Outside the map the page scrolls as usual.

## Navigation modes

How a drag moves the camera. Choose it at start with the `navigationMode` option and change it at runtime; the default is `'free'`.

```ts
const controls = createControls({ navigationMode: 'north-up' });
// …later, for example from a settings menu:
controls.setNavigationMode('free');
console.log(controls.navigationMode); // 'free'
```

| Mode               | A drag                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'free'` (default) | Turns the globe about any axis, like a trackball (Google Earth): the grabbed point stays under the cursor, the view passes over the poles without stopping, and the heading turns with the globe (north is no longer up after a diagonal drag or a pass over a pole). On the flat map, at regional and street scale, a drag keeps the heading.                                                                                                                                                                 |
| `'north-up'`       | Keeps north up: horizontal motion turns the globe about the polar axis, vertical motion changes the latitude, and the heading never changes. The point the camera looks at stops at a latitude limit, 85° by default (`northUpMaxLatitudeDeg`, from 1 to 89.9, or `setNorthUpMaxLatitude` at runtime): vertical motion beyond it is ignored, horizontal motion still turns about the axis, with no jump, no flip and no spin about the pole. A camera placed beyond the limit stays there and goes no further. |

In both modes inertia, zoom to the cursor, tilt and rotation gestures, and the compass (`resetNorth`, the `N` key, a click on the UI's compass: north up) work the same; a wheel zoom never turns the heading. Any value other than `'free'` and `'north-up'` throws a `GlobeError` (`invalid-option`). An input plug-in of its own sets `NavigationApi.navigationMode` on the navigation interface it receives.

In the playground, `?navigationMode=north-up` starts in that mode and the "Navigation mode" selector (the settings panel on the showcase page) switches it.

## Tilt policy

By default the engine's zoom curves tilt the view near street level (Auto mode), and any tilt can be chosen at any
distance. The tilt policy (F625) ties the tilt to the distance from the camera to the point it looks at instead (the
height above the ground when looking straight down):

```ts
const controls = createControls({ tiltPolicy: true }); // 20,000 m, 2,000 m, 60°
controls.setTiltPolicy({ lock2DAboveMeters: 20_000, autoTiltBelowMeters: 2_000, autoTiltMaxDeg: 60 });
controls.onTiltAvailabilityChange((available) => (button3d.disabled = !available));
```

| Field                 | Default  | Effect                                                                                                                                                                                            |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lock2DAboveMeters`   | 20,000 m | Beyond this distance the tilt is 0° and cannot change: tilt gestures only turn, `jumpTo({ tiltDeg })` and the 3D mode leave it flat. `tiltAvailable` is false and the UI's 3D button is disabled. |
| `autoTiltBelowMeters` | 2,000 m  | Within this distance the tilt rises by itself, from 0° here to `autoTiltMaxDeg` at a quarter of it (500 m); zooming out lowers it again. Both follow the distance continuously, with no jump.     |
| `autoTiltMaxDeg`      | 60°      | The automatic tilt near the ground, and the tilt the 3D mode chooses; at most `maxTiltDeg`.                                                                                                       |

A tilt chosen by hand below the lock stays at every distance until it is changed, or until the camera passes the lock:
over the last halving of the distance before the lock (10 to 20 km by default) the allowed tilt falls continuously to
0°, and beyond the lock the view returns to Auto. `setTiltPolicy(false)` (or `null`) turns the policy off; invalid
values throw a `GlobeError` (`invalid-option`). The UI's 2D / 3D / Auto toggle takes the controls as its `tilt` option
(`new ViewModeControl({ tilt: controls })`, or `addAllControls(ui, { tilt: controls })`). In the playground,
`?tiltPolicy=1` turns the policy on; the showcase page has it on. In Vue, `VibeGlobe`'s `controls` prop takes the same
options (`:controls="{ tiltPolicy: true }"`), and `useTiltAvailable()` returns the availability as a ref.

## Key map

The keys work while the map has focus (Tab reaches it; a focus ring shows when it is reached from the keyboard). Keys typed into other elements of the page never move the map, and keys with Ctrl, Alt or Meta are left to the browser.

| Key                     | Action                                                         |
| ----------------------- | -------------------------------------------------------------- |
| Arrows                  | Pan while held, with an eased start and stop                   |
| Shift+Left, Shift+Right | Rotate while held                                              |
| Shift+Up, Shift+Down    | Tilt while held                                                |
| `+` / `=`, `-`          | Zoom in / out one level about the center; presses accumulate   |
| `N`                     | Turn to north up                                               |
| Home                    | Fly to the home view (when the engine offers `goHome`)         |
| `2`, `3`, `A`           | 2D, 3D and Auto view modes (when the engine offers view modes) |
| Escape                  | Cancel a zoom box                                              |

## Options

Every option is optional; invalid values throw a `GlobeError` with code `invalid-option`.

```ts
createControls({
  gestures: { boxZoom: false, inertia: true }, // switch single gestures off
  inertia: {
    panTauMs: 650,
    rotateTauMs: 650,
    twistTauMs: 200,
    tiltTauMs: 150,
    zoomTauMs: 150,
    velocityWindowMs: 50,
    stillMs: 150,
    stillPx: 2,
    maxPanSpeedPxPerS: 2500,
  },
  wheel: { pixelsPerLevel: 300, pinchPixelsPerLevel: 100, notchSmoothingMs: 100, maxLeadLevels: 2 },
  keyboard: { panViewportsPerS: 0.8, rotateDegPerS: 90, tiltDegPerS: 45, smoothingMs: 150, zoomLevelsPerPress: 1 },
  touch: { tapMaxMovePx: 10, tapMaxMs: 250, doubleTapMs: 300, tiltDecisionMs: 100, rotateThresholdPx: 25 },
  rotateDegPerViewportWidth: 180,
  tiltDegPerViewportHeight: 90,
  maxTiltDeg: 89,
  zoomAnimationMs: 120,
  reducedMotion: 'system', // 'reduce' or 'no-preference' to override the system setting
});
```

Gesture switches: `dragPan`, `wheelZoom`, `doubleClickZoom`, `boxZoom`, `dragRotate`, `touchZoom`, `touchRotate`, `touchTilt`, `keyboard`, `inertia`.

On a display too slow to show an animation (frames of an animation more than three of its time constants apart, as on software GPUs), wheel notches and the zoom commands apply in one step instead of costing frames.

With reduced motion (the system's `prefers-reduced-motion: reduce`, followed at runtime, or `reducedMotion: 'reduce'`) inertia lasts a quarter as long.
