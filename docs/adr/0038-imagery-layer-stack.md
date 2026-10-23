# 0038. The imagery layer stack

- Status: Accepted (decided by agent; owner may revisit)
- Date: 2026-10-23
- Milestone: M7 (layer composition, chains; docs/plan/api.md "Layer composition")

## Context

Until M7 each surface tile showed the topmost imagery source that had a tile for it, else the world base image. M7
asks for layers in an order the application changes at runtime (F243), each with an opacity (F244), a visibility
(F245) and a blend mode (F246), and for a layer made of a chain of sources with priorities and failover (F247, F248).
The frame loop allocates nothing (F064) and every draw of the surface shares one material and pipeline (ADR 0010).

Options considered:

1. **Composite in the surface shader**: each draw keeps its own imagery (the base) and gains a fixed number of overlay
   slots, each a texture with its UV transform, opacity and blend mode, composed in the fragment shader.
2. Draw each translucent layer as a second pass of the surface meshes with alpha blending. Simple per layer, but every
   overlay doubles the vertex work and the depth of the second pass fights the first.
3. Composite every tile's layers into one texture on the GPU when its tiles arrive. One sample per pixel at draw time,
   but a render-to-texture step per tile and per change, and a runtime opacity change re-composites every tile.

## Decision

Option 1, with two overlay slots.

- **Layers.** `GlobeOptions.imagery` takes sources or `{ id, sources, opacity, visible, blend }`; a source alone is a
  layer of one source. `Globe.imageryLayers` lists them bottom first and changes a layer's look (`set`) or position
  (`move`); the next frame shows the change at once, without the cross-fade of arriving tiles.
- **Base and overlays.** Per draw, the topmost visible layer that is opaque (opacity 1, normal blend) and has a resident
  tile is the draw's own imagery; the visible translucent or blended layers above it fill the overlay slots, bottom
  first, at most two (the two topmost). A layer at opacity 0 or hidden requests no tile; a hidden layer's cached tiles
  stay in the caches, so showing it again draws them on the next frame.
- **Blending.** In linear light, as the rest of the surface: normal `mix(c, o, a)`, multiply `mix(c, c·o, a)`, screen
  `mix(c, 1 − (1 − c)(1 − o), a)`, with `a` the layer's opacity times the texel's alpha.
- **Chains.** Each source of a chain has its own loader. A tile comes from the first source that has it at the
  surface's level (within its levels and coverage, not missing, not backing off after a failure); while that source's
  tile loads, a resident tile of another source stands in; where no source has it, the first source that covers the
  area shows its deepest tile magnified. Levels an earlier source serves are its own: a later source is asked only for
  finer ones, and only the first source of a chain pins a base. A source has nothing outside its declared coverage, so
  the layers below show there. A failing source is tried again after its backoff, so the layer switches back when it
  recovers.

## Consequences

- One extra uniform matrix and two texture bindings per draw; a slot at opacity 0 samples nothing (the branch is
  uniform per draw), so a stack without overlays costs what it did before.
- More than two overlays above a base show only the two topmost; the limit is `MAX_OVERLAYS` in core and the slots in
  `surface-material.ts`.
- Overlays switch level without a cross-fade (only the base fades, F105).
