# 0029. Data layers: feature storage, styling, clustering, labels and picking ids

- Status: Accepted
- Date: 2026-10-22
- Milestone: M10

## Context

`PLAN.md` (Data layers for applications) asks for points, markers, labels, lines, polygons, circles and models with data-driven and zoom-dependent styles, clustering for hundreds of thousands of points, labels with collision and priorities, picking with events, and single-feature live updates without rebuilding a layer. The surveys [picking](../research/picking.md), [labels](../research/labels.md) and [data layers](../research/data-layers.md) cover how CesiumJS, MapLibre GL JS and Native, deck.gl, OpenLayers, iTowns, Tangram, three.js and Potree do it.

Since 2026-10-22 a parallel session builds the parts of M10 that do not need renderer internals in `packages/layers` (`docs/parallel-tracks.md`); drawing, draping, clamping and glTF stay with the main session. The layers package therefore needs a small interface to draw through.

## Options considered

1. **Storage.** Object per feature (Cesium's collections): simple, but memory and garbage grow with the feature count and every change walks objects. Structure-of-arrays with dirty ranges (deck.gl's attribute manager, Cesium's newer buffer collections): one typed column per attribute, partial uploads.
2. **Styling.** An own expression evaluator, or the MapLibre Style Specification's evaluator (`@maplibre/maplibre-gl-style-spec`, ISC), which defines the semantics `docs/plan/architecture.md` requires and is shared later by vector tiles.
3. **Clustering.** Cesium's per-camera screen-space clustering (clusters change while panning), or a hierarchical index per integer zoom (supercluster, ISC, used by MapLibre).
4. **Label collision.** A uniform grid (MapLibre, Native) or an R-tree (`rbush`, MIT); placement every frame or on a fixed interval with fades.
5. **Picking ids.** Per-feature id objects (Cesium) or a packed integer split into a layer slot and a row index (deck.gl, Potree).

## Decision

- **Draw interface.** Layers draw through `LayerRenderTarget` (`packages/layers/src/render-target.ts`): batches of one primitive kind with numeric attributes (position in float64 degrees and meters, colors, sizes, opacity, anchor, visibility factor, pick id), text and icon channels, line and polygon geometry, per-batch uniforms for zoom-only styles, draw order and visibility. `RecordingRenderTarget` is the test double and the upload instrumentation. The renderer implements the interface; the hooks requested are in `docs/parallel-tracks.md`.
- **Storage.** Structure-of-arrays per layer (`FeatureStore`). A change sets a per-row dirty flag only when a value changes; the upload coalesces flags into contiguous runs per attribute, so a single-feature update uploads one row (F376, F377). Removal moves the last row into the hole, so rows stay dense and one row is re-uploaded. Growth doubles the capacity and asks the renderer to grow the batch, which is not a rebuild.
- **Styling.** MapLibre property names and expressions, compiled with `createPropertyExpression` against the specification's property definitions, so malformed expressions and unknown properties are rejected when the layer is created, with every problem listed (`StyleError`). Constant and zoom-only properties become batch uniforms evaluated once per frame; feature-dependent ones are written per row; zoom-and-feature ones are re-evaluated when the zoom changes. Feature state (`['feature-state', …]`) carries hover and selection styles.
- **Clustering.** supercluster behind an asynchronous `ClusterEngine`, so the index can move into the shared worker pool (ADR 0011) without changing the layer. The layer shows the clusters of the whole world at each integer zoom, so counts always add up to the number of points and clusters do not change while panning. Splits and merges animate: a child's parent is the nearest item of the coarser zoom within one cluster radius.
- **Labels.** Placement passes at most every 300 ms and whenever labels are added or removed. Labels are tried in order of `symbol-sort-key` (lower first), then feature id, and kept when their padded box overlaps no kept box in an `rbush` tree. Labels behind the globe or off screen are hidden. Opacity moves toward each decision over a 300 ms fade on the engine clock and is uploaded as the visibility factor. Collision boxes use the renderer's glyph metrics once available, an estimate until then.
- **Picking ids.** A 32-bit id in RGBA8: 8-bit layer slot (1–255) and 24-bit row index, 0 for nothing. The layer stack owns the slot table and hands out slots round-robin, so a late readback never names a newer layer. A pick reads a small region and takes the non-zero pixel nearest its center. Interaction drops a pick answered after a newer one, so hover events never step backwards.
- **Layer plug-in interface.** `Layer` (attach, detach, frame, order, visibility) is public; built-in and application layers implement the same interface (F388).
- **Data loading.** `VectorFormatAdapter` wraps the M7 parsers of `@vibeglobe/sources/vector` (ADR 0030) for GeoJSON, KML and GPX; a parser's issues become the layer's error events. Parsing runs on the calling thread until the worker program registers the parsers' tasks.

## Consequences

- The layers package is tested in Node with the recording target: one focused test per behavior of F359, F360, F369, F370, F372, F373, F376, F377, F379–F382 and F385 (`packages/layers/src/*.test.ts`). The entries themselves pass once the renderer draws the batches and the browser steps run.
- The renderer must implement `LayerRenderTarget`, an id-buffer pass and glyph metrics; clustering and vector parsing must move into the worker pool. These are the hook requests in `docs/parallel-tracks.md`.
- Cluster diffs run on the calling thread for now: adding about 70,000 items at a zoom change takes about 0.7 s in Node, so the diff moves into the worker and is applied in slices before F375 and F389 are measured (`docs/follow-ups.md`).
- A 10,000-label placement pass takes 20–30 ms warm in Node; it is time-sliced under the frame budget before F359's browser measurement.
- The style-spec package is 9.7 MB unpacked, but a minified bundle of the layers package with its dependencies is 145 KB (39 KB gzipped; esbuild 0.28, 2026-10-22). The layers package loads with the application's data, not in the initial engine bundle of F546; the bundle-size check measures it when it joins the playground.
