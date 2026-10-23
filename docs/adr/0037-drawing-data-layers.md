# 0037. Drawing data layers in the renderer

- Status: Accepted (decided by agent; owner may revisit)
- Date: 2026-10-22
- Milestone: M10 (renderer side; the layers package, ADR 0029, was built by the data layers track)

## Context

`@vibeglobe/layers` draws only through `LayerRenderTarget` (ADR 0029): structure-of-arrays batches of points,
markers, labels, polylines, polygons and circles, with per-feature attributes, ranges written as they change, string
channels for text and icons, and line and polygon geometry per feature. The main session implements it in the renderer.
Every primitive must be placed with the surface's precision (ADR 0004), follow the globe-to-flat morph and the tilt
(ADR 0008, ADR 0034) in every phase, support ground clamping, draping and absolute altitudes, and be pickable.

Options considered:

1. Project every feature on the CPU each frame and draw screen-space triangles. Simple, but the depth against the globe
   and terrain must be rebuilt, and the cost grows with every vertex every frame.
2. **Draw batches as meshes on the surface's own vertex path**: each vertex carries the same attributes a surface tile
   vertex does (a float32 offset from the batch's float64 ECEF origin, the normal, the Mercator offset from the batch's
   plane center), so one vertex node places it eye-relative between the globe and the flat map. Screen-sized parts
   (point and marker sizes, line widths, label quads) are offsets in pixels added in clip space after projection.
3. Use three.js's own `Points`, `Line2` and `Sprite` objects: they assume float32 world positions and no morph.

## Decision

Option 2.

- **Types in core.** `LayerRenderTarget` and its types move to `@vibeglobe/core` (types only, no runtime code), and the
  layers package re-exports them, so the renderer implements them without depending on `@vibeglobe/layers`. The renderer
  backend exposes `layers: LayerRenderTarget`; `Globe.layerTarget()` hands it to layer stacks.
- **Geometry.** Core's surface-mesh helpers write the per-vertex attributes of any geodetic position (shared with the
  tiles), so a batch is a mesh like a tile. Points, markers and circles are instanced quads around their anchor; lines
  are quads per segment extruded in screen space from the projected segment direction; polygons are triangulated with
  `earcut` (ISC) in the renderer, holes included; extrusions add walls and a roof between `baseMeters` and
  `heightMeters`.
- **Placement.** Absolute altitudes use the given heights. Clamped and draped features take the displayed terrain's
  height per vertex from core's height queries when written and again when the terrain under them refines (the
  `terrain-refined` notification of M4); without terrain they lie on the ellipsoid. Draping beyond vertex clamping
  (a texture pass over the terrain) is left for hardening.
- **Labels and icons.** Glyphs and icons are rasterized once into an atlas with the browser's 2D canvas (OffscreenCanvas
  where available) and drawn as quads; the text measurer of the layers package is replaced by the atlas's metrics.
- **Picking.** A second render of the visible batches writes each feature's `pickId` into an id target on request
  (`pickAt`), read back for the pointer pixel only.
- **Order and blending.** Batches draw after the surface, in `setOrder` order, alpha-blended, depth-tested against the
  surface, without writing depth (labels and markers on top of lines and polygons).

## Consequences

- Layers inherit the surface's precision and morph without a second implementation; screen-space sizes stay constant
  in every phase.
- Per-frame cost is one draw per visible batch; writes upload only the changed ranges (F376, F377).
- Polygon triangulation runs on the calling thread until the worker program registers it (a hook already recorded).
- glTF models load with three.js's glTF loader, which shows images embedded in a model's buffers through `blob:` image
  URLs: a page with a strict Content Security Policy that loads such models adds `blob:` to `img-src`. They are images,
  not code, so F100's rule (no generated code) holds; models with external or `data:` images need nothing more.
