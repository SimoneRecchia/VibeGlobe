# Manual tablet checklist (M6, F217)

The navigation that Chromium's emulated touch cannot prove: run it on each reference tablet (`docs/internal/open-questions.md`,
question 2), iPadOS Safari and Android Chrome, and record the results in the table at the end. The automated suites
(`e2e/controls-*.spec.ts`, `e2e/ui-navigation.spec.ts`) already cover the same interactions with mouse, keyboard and
emulated touch.

## Setup

1. On a machine on the tablet's network, run `npm run dev -- --host` (the playground on port 5173).
2. On the tablet, open `http://<machine>:5173/e2e/support/controls.html` (the controls harness), then the playground
   itself, `http://<machine>:5173/?lon=10&lat=45&zoom=5`.
3. Turn on the frame-time readout with `&debug=1` for the frame-rate checks.

## Checks

| #   | Entry | Do                                                          | Expect                                                                                   |
| --- | ----- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | F171  | Double-tap a city; single-tap; tap then drag                | One level in, animated, at the tap; the single tap and the tap-drag do not zoom          |
| 2   | F172  | Two-finger tap                                              | One level out about the fingers' midpoint                                                |
| 3   | F173  | Pinch in and out slowly, then fast                          | Continuous zoom that follows the finger spread (twice the spread is one level), anchored |
| 4   | F180  | Two-finger pan, then release with speed                     | The content stays under the fingers; it coasts and slows to rest                         |
| 5   | F184  | Twist two fingers, alone and while pinching and panning     | The heading turns about the midpoint; small twists during a pinch do not rotate          |
| 6   | F185  | Drag two fingers vertically together                        | The view tilts; no zoom, pan or rotation                                                 |
| 7   | F186  | One finger pan, add a second, pinch, lift one, keep panning | No jump at any finger change                                                             |
| 8   | F217  | Pan, pinch, twist and tilt for a minute with the readout on | At least 30 fps throughout (frame time at most 33.3 ms)                                  |
| 9   | F189  | Scroll the page outside the map, then pinch over the map    | The page scrolls outside; over the map only the map zooms, the page never zooms          |

## Results

| Date | Tablet and browser | Checks passed | Notes |
| ---- | ------------------ | ------------- | ----- |
|      |                    |               |       |
