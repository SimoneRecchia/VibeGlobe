---
title: Vector tiles
---

# Vector tiles

`addVectorTiles` of `@vibeglobe/layers/vector-tiles` draws a [MapLibre Style Specification](https://maplibre.org/maplibre-style-spec/)
style from Mapbox Vector Tiles on the globe, through the globe-to-flat morph and on the flat map, draped on terrain.
`createVectorTileTarget` of `@vibeglobe/renderer/vector-tiles` is its renderer side. For ready map types of Europe
and the world, use the [Europe preset](europe-preset.md); for application data from GeoJSON, use
[data layers](data-layers.md).

## Quick start

```ts
import type { Globe } from '@vibeglobe/core';
import { addVectorTiles } from '@vibeglobe/layers/vector-tiles';
import { createVectorTileTarget } from '@vibeglobe/renderer/vector-tiles';

declare const globe: Globe;

await globe.ready;
const layer = await addVectorTiles(globe, {
  style: 'https://tiles.example.com/styles/streets.json', // or the style's JSON
  target: createVectorTileTarget,
  element: container, // hover and click
});
```

The promise resolves once the style and its sources are read; tiles stream from the next frame.

## Styles and sources

The style loads without edits. Its sources (tile URL templates, TileJSON, or GeoJSON data cut into tiles locally),
`glyphs` and `sprite` URLs are read as they are, and relative URLs resolve against the style's URL. `transformUrl`
rewrites every URL the style leads to (TileJSON, tiles, glyphs, sprites) before it is requested, as MapLibre's
`transformRequest` does; the style's own URL is not rewritten. Tiles are requested through the engine's request pool
(per-host limits, coalescing, cancellation), laid out in the engine's workers, and kept with their bytes. Video and
image sources are not drawn.

Every layer type of the specification draws: `background`, `fill`, `line`, `symbol`, `circle`, `fill-extrusion`,
`raster`, `hillshade`, `color-relief` and `heatmap`. `raster` and `raster-dem` sources are read, the latter in
Terrarium or Mapbox encoding; `line-gradient` draws on GeoJSON sources with `lineMetrics`; `fill-pattern` reads the
sprite.

## Runtime changes

`layer.style` is a `VectorStyle` that changes at runtime: `setPaintProperty`, `setLayoutProperty`, `setFilter`,
`setVisibility`, `setLayerZoomRange`, `addLayer` and `removeLayer`. No tile is downloaded again.

```ts
import type { VectorTileLayer } from '@vibeglobe/layers/vector-tiles';

declare const layer: VectorTileLayer;

layer.style.setPaintProperty('water', 'fill-color', '#2060c0');
layer.style.setVisibility('poi-labels', false);
layer.style.setFilter('roads', ['==', ['get', 'class'], 'motorway']);
const problem = layer.style.setLayoutProperty('place-labels', 'text-size', 'large');
if (problem) console.warn(problem.path, problem.message); // invalid: nothing changed
layer.setLanguage('it');
layer.setFeatureState({ source: 'openmaptiles', id: 42 }, { selected: true });
```

| Change                             | Shows                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------- |
| Paint, feature state               | On the next frame: paint is evaluated per feature and rewritten in place               |
| Visibility, zoom range             | Cross-fades over 300 ms on the engine clock                                            |
| Layout, filter, added layer, order | Within 1 s: the kept tiles are laid out again in the workers, old ones drawn meanwhile |

A paint change rewrites only its own layer's meshes, and a symbol layer has none: labels evaluate paint every frame,
so changing a label layer's paint costs nothing. Visibility and zoom ranges rewrite no mesh. A feature-state change
rewrites every layer's meshes.

`setFeatureState({ source, id }, state)` sets state for `['feature-state', …]` expressions. `setLanguage('it')`
shows names as `name:it`, else `name_it`, else `name`, in every symbol layer whose `text-field` reads a name.

## Drawing

- Vector tiles are chosen from the surface's tiles and the ground scale on screen (512-pixel tiles). Beyond a
  source's `maxzoom` its deepest tiles are overzoomed. While a tile loads, or where a source has no tile, its nearest
  ready ancestor is drawn clipped to the missing square.
- Line widths, dashes, circle radii and text sizes are in CSS pixels on the screen, in every phase and at every tilt.
  Paint between two integer zooms is mixed continuously.
- Meshes are built and repainted within 6 ms of main-thread time per frame, at least one per frame. Tiles past the
  budget come in the next frames; meanwhile the kept mesh of a tile around them, or of its children, is drawn clipped
  to their square.
- Fills and lines are draped on terrain: each vertex takes the height of the terrain in memory under it, again when
  finer terrain arrives, within 4 ms of main-thread time per frame. Draped features are drawn 0.3% of their distance
  nearer the eye than the ground, so they never fight its depth.
- Buildings (`fill-extrusion`) take their heights from their tags (see [data layers](data-layers.md#buildings)),
  grow from the ground as their layer fades in, and on the flat map scale their height by the Mercator scale factor.
- Labels: point labels and labels along lines, with collision in style priority, fades, and no duplicates across tile
  edges. Glyph ranges are requested only for the characters in use. Characters the style's glyphs lack are drawn
  locally in `localFontFamily` when given, else left out.
- Hillshade and color-relief images are made on the main thread's CPU, once per DEM tile and paint. As finer terrain
  arrives, their meshes take the new ground in place.

## Picking and events

`layer.queryRenderedFeatures({ xPx, yPx })` returns every feature drawn under a point, topmost first (labels, then
layers from the top down). Each `PickedVectorFeature` has `layerId`, `source`, `sourceLayer`, `id`, `properties`,
`position` and, for buildings, `building` (`heightMeters`, `baseMeters`, `source`). With `element`, `layer.on` receives
`hover`, `hoverend` and `click` events, and the layer sets the `hover` and `selected` feature states.

```ts
import type { VectorTileLayer } from '@vibeglobe/layers/vector-tiles';

declare const layer: VectorTileLayer;

const off = layer.on(({ type, feature }) => {
  if (type === 'click') console.log(feature.layerId, feature.properties['name']);
});
const [top] = layer.queryRenderedFeatures({ xPx: 200, yPx: 150 });
console.log(top?.building?.heightMeters);
off();
```

A press and release within 5 CSS pixels of each other count as a click.

## Labels an application follows

`layer.labelAnchors(layerId, property)` says where the last frame placed the labels of a symbol layer, keyed by the
value of a feature property: each `PlacedLabel` has its anchor on the ground (`position`) and on screen
(`screenPoint`), with `text`, `boxes` and `feature`. Of several labels with one value, the first is kept.

`layer.setLabelsHidden(layerId, labels)` keeps labels placed without drawing them: `true` hides every label of the
layer, `false` none, and `{ property, values }` those whose feature property has one of the values. Each call
replaces the layer's last choice. A hidden label keeps its room in collision, so the names around it stay where they
are, and `labelAnchors` still lists it. It fades out over 300 ms on the engine clock and back in when shown again.
`placedLabels()` and picking leave hidden labels out once they have faded.

```ts
import type { VectorTileLayer } from '@vibeglobe/layers/vector-tiles';

declare const layer: VectorTileLayer;
declare const marker: HTMLElement;

// A marker grows out of Italy's name, which stays placed but hidden.
layer.setLabelsHidden('country-names', { property: 'iso_a2', values: ['IT'] });
const italy = layer.labelAnchors('country-names', 'iso_a2').get('IT');
if (italy) marker.style.transform = `translate(${italy.screenPoint.xPx}px, ${italy.screenPoint.yPx}px)`;
```

## Options

`VectorTilesOptions`:

| Option            | Type                             | Default            | Effect                                                         |
| ----------------- | -------------------------------- | ------------------ | -------------------------------------------------------------- |
| `style`           | URL `string` or style JSON       | required           | The style                                                      |
| `target`          | `(renderer) => VectorTileTarget` | required           | `createVectorTileTarget` of `@vibeglobe/renderer/vector-tiles` |
| `element`         | `HTMLElement`                    | none               | Whose pointer events hover and click features                  |
| `transformUrl`    | `(url) => string`                | none               | Rewrites TileJSON, tile, glyph and sprite URLs                 |
| `transport`       | `TileTransport`                  | `fetchTransport()` | Tile requests                                                  |
| `fetch`           | `typeof fetch`                   | the global `fetch` | Style, TileJSON, glyph and sprite documents                    |
| `localFontFamily` | `string`                         | none               | CSS font family for characters the glyphs lack                 |

## Rules and pitfalls

- Change the style in place instead of making a new layer. `layer.remove()` and a new `addVectorTiles` download,
  decode and lay out every tile again. Build one style with every optional part in it, hidden with
  `layout.visibility: 'none'`, and switch parts with `setVisibility`; rebuild only when the source itself changes.
- A filter's `['zoom']` is the whole zoom of the tile being laid out, not the camera's: a filter that hides features
  below zoom 5 shows them wherever level-5 tiles are drawn, which can be zoom 4.5. For a limit at a fractional zoom,
  use the layer's `minzoom` and `maxzoom`, which follow the camera.
- Prefer `setLabelsHidden` to a `text-opacity` expression: a label at opacity 0 is still picked, and its fade follows
  the style instead of the page.
- A tilted view draws many DEM tiles at once: give `hillshade` and `color-relief` layers a `maxzoom` where the 3D
  terrain already shows the relief.
- The style is not rejected for its problems: invalid layers and properties are dropped, logged with the prefix
  `[vibeglobe] vector tiles:`, and listed in `layer.style.problems`.

## Errors

| Error or code                   | When                                                              | What to do                                              |
| ------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------- |
| `Error` `<url>: HTTP <status>`  | The style URL answers an error status (`addVectorTiles` rejects)  | Check the style URL; `transformUrl` does not rewrite it |
| `GlobeError` `'invalid-option'` | `addVectorTiles` before `globe.ready`                             | Await `globe.ready` first                               |
| `StyleProblem` returned         | A runtime change with an invalid value; nothing changes           | Read `path` and `message`                               |
| `layer.style.problems`          | Invalid style parts, or a source whose TileJSON could not be read | Fix the style or the source                             |

## See also

- [Europe preset](europe-preset.md): ready vector map types and their offline package.
- [Sources](sources.md): vector tile sources, PMTiles and MBTiles, provider profiles.
- [Data layers](data-layers.md): building heights and application data.
