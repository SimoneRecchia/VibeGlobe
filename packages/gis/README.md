# vibeglobe/gis

Pure GIS functions, usable without the renderer or the UI: coordinate formatting and parsing (decimal degrees,
degrees-minutes-seconds, UTM), reference-system transforms through proj4js, geodesic measurement on WGS84, the camera's
view state in URLs and JSON, and grids on the ground (`gridLines`). `vibeglobe/ui` uses it for its readout, search box and measurement; an application calls it directly
for its own coordinate fields, measurements, shareable links or layout editors.

## Install

Part of `vibeglobe`: `npm install vibeglobe`, then import from `vibeglobe/gis`.

## Entry points

| Import path     | What                                                                 |
| --------------- | -------------------------------------------------------------------- |
| `vibeglobe/gis` | Coordinates, reference systems, measurement, view state, `gridLines` |

## Example

```ts
import { formatCoordinate, formatLength, measureDistance, parseCoordinate } from 'vibeglobe/gis';

const milan = parseCoordinate('45°27′51.1″N 9°11′24.0″E');
const rome = { longitudeDeg: 12.4964, latitudeDeg: 41.9028 };
if (milan) {
  formatCoordinate(milan, 'utm'); // '32T 514853 5034536'
  formatLength(measureDistance(milan, rome).distanceMeters, 'it'); // '477 km'
}
```

## Pitfalls

- Positions are `{ longitudeDeg, latitudeDeg }`; `transformCoordinates` takes `{ x, y }`, longitude first for
  geographic systems.
- `formatCoordinate` returns undefined for UTM outside 80°S to 84°N. It and `transformCoordinates` throw a
  `RangeError` for invalid input or an unknown code.
- `gridLines` needs a `spacingM` above 0 and returns at most 2000 lines.

## Guides

[UI and GIS](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/ui-and-gis.md).
