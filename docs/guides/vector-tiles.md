# Vector tiles

VibeGlobe draws [MapLibre Style Specification](https://maplibre.org/maplibre-style-spec/) styles from Mapbox Vector
Tiles on the globe, through the globe-to-flat morph and on the flat map, draped on terrain (M13, ADR 0131, ADR 0132).

```ts
import { createGlobe } from '@vibeglobe/core';
import { addVectorTiles } from '@vibeglobe/layers/vector-tiles';
import { createVectorTileTarget } from '@vibeglobe/renderer/vector-tiles';

await globe.ready;
const layer = await addVectorTiles(globe, {
  style: 'https://tiles.example.com/styles/streets.json', // or the style's JSON
  target: createVectorTileTarget,
  element: container, // hover and click
});
```

The style loads without edits: its sources (tile URL templates, TileJSON, or GeoJSON data cut into tiles locally),
`glyphs` and `sprite` URLs are read as they are, relative URLs resolved against the style's URL. `transformUrl` maps
them to another host without editing the style (MapLibre's `transformRequest`); the playground's
`?vectorStyle=demotiles` loads MapLibre's demotiles style (BSD-3-Clause) unchanged this way, from fixture tiles. Tiles are requested through the engine's request pool (its
per-host limits, coalescing and cancellation), laid out in the engine's workers, and kept with their bytes.

## Runtime changes

`layer.style` changes the style at runtime (`setPaintProperty`, `setLayoutProperty`, `setFilter`, `setVisibility`,
`setLayerZoomRange`, `addLayer`, `removeLayer`); no tile is downloaded again:

| Change                             | Shows                                                                                   |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| Paint, feature-state               | On the next frame: paint is evaluated per feature and rewritten in place.               |
| Visibility, zoom range             | Cross-fades over 300 ms on the engine clock.                                            |
| Layout, filter, added layer, order | Within 1 s: the kept tiles are laid out again in the workers, old ones drawn meanwhile. |

`layer.setFeatureState({ source, id }, state)` sets feature-state for `['feature-state', …]` expressions;
`layer.setLanguage('it')` shows names as `name:it`, else `name_it`, else `name`.

Prefer these to a new layer. `layer.remove()` and a new `addVectorTiles` download, decode and lay out every tile again:
a page that rebuilds its layer when a checkbox, a language or a filter changes, or on every refresh of its own data,
redraws its borders and names every time. Build one style with every optional part in it, hidden with
`layout.visibility: 'none'`, and switch parts with `setVisibility`; rebuild only when the source itself changes.

A filter's `['zoom']` is the zoom of the tile being laid out, a whole level, not the camera's: a filter that hides
features below zoom 5 shows them from wherever level-5 tiles are drawn, which can be zoom 4.5. For a limit at a
fractional zoom use the layer's `minzoom` and `maxzoom`, which follow the camera.

## Drawing

- Every view's vector tiles are chosen from the surface's tiles and the ground scale on screen (512-pixel tiles).
  Beyond a source's `maxzoom` its deepest tiles are overzoomed; while a tile loads, or where a source has no tile, its
  nearest ready ancestor is drawn clipped to the missing square.
- Line widths, dashes, circle radii and text sizes are in CSS pixels on the screen, in every phase and at every tilt;
  paint between two integer zooms is mixed continuously.
- Fills and lines are draped on terrain: each vertex takes the height of the terrain in memory under it, again when
  finer terrain arrives (within 4 ms of main-thread time per frame). Draped features are drawn 0.3 % of their distance
  nearer the eye than the ground, so they never fight its depth.
- Buildings (`fill-extrusion`) take their heights from their tags (see [data layers](data-layers.md#buildings)),
  grow from the ground as their layer fades in, and on the flat map scale their height by the Mercator scale factor.
- Labels: point labels and labels along lines, with collision in style priority, fades and no duplicates across tile
  edges. Glyph ranges are requested only for the characters in use; characters the style's glyphs lack are drawn
  locally in `localFontFamily` when given, else left out.

- Every layer type of the specification draws (ADR 0133): `raster` and `hillshade` (raster and raster-dem sources,
  Terrarium or Mapbox encoding) and `heatmap` as images per tile; `line-gradient` on GeoJSON sources with
  `lineMetrics`; `fill-pattern` from the sprite; `fill-outline-color`.
- Hillshade and color-relief images are made on the CPU of the main thread, once per DEM tile and paint; as finer
  terrain arrives their meshes take the new ground in place (KB-242). A tilted view
  draws many DEM tiles at once: give such layers a `maxzoom` where the 3D terrain already shows the relief (the Europe
  preset's Landscape stops at 11).

## Picking

`layer.queryRenderedFeatures({ xPx, yPx })` returns the features under a point, topmost first (labels, then layers
from the top down), with their layer, properties, position and, for buildings, their heights. With `element`, hover
and click events reach `layer.on(listener)` and set the `hover` and `selected` feature-states.
