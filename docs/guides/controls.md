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
  inertia: { panTauMs: 200, rotateTauMs: 200, tiltTauMs: 150, zoomTauMs: 150, maxPanSpeedPxPerS: 2500 },
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
