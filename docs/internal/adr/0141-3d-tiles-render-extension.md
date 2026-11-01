# 0141. 3D Tiles drawn by a render extension: per-tile rigid placement, a relative depth pull and Google sessions

- Status: Accepted (partly superseded by 0185)
- Date: 2026-10-23
- Milestone: M13

## Context

ADR 0041 built the computational parts of 3D Tiles (tileset and content parsing, implicit tiling, traversal by
screen-space error with REPLACE and ADD, request priorities, the LRU byte budget). Track E (`docs/internal/parallel-tracks.md`,
round 3) draws them without touching `core` or the renderer's loop, through `Globe.addRenderExtension` and the
context it receives (`renderer`, `network`, `workers`), with meshes built from `@vibeglobe/models`' `ModelDescription`
(ADR 0121), and adds Google Photorealistic 3D Tiles (F468–F470) under the Google profile (ADR 0031). Three questions
had no answer in ADR 0041: where content is placed while the map flattens (ADR 0008), how a tileset whose ground
coincides with the engine's terrain avoids z-fighting (F467), and how Google's 3D Tiles sessions are kept alive.

## Options considered

1. **Placement through the morph.** (a) Morph every vertex in the shader like the surface (ADR 0008): exact, but
   content is arbitrary glTF, its vertices in tile-local frames, so every material would need the surface's morph
   attributes. (b) Place the whole tileset rigidly about one anchor (its root's center). (c) Place each tile rigidly
   about its own center.
2. **Overlap with terrain.** (a) Polygon offset: units and slopes behave differently on WebGPU, WebGL2 and the
   fragment-depth path (ADR 0005). (b) Clip the terrain under the tileset's footprint: needs the surface's shader.
   (c) Draw content slightly nearer along each vertex's own line of sight (scale its eye-relative position by
   `1 − ε`): the picture does not move, only the depth; the same expression serves the fragment-depth path.
3. **Google sessions.** Google's 3D Tiles have no `createSession` call: the root tileset starts a session and writes
   its token into the content URIs. (a) Keep the token Google wrote into each URI; (b) let the adapter's transport
   sign every request with the current session and the key, starting a new session before its lifetime ends and once
   after a refusal.

## Decision

1. **Option (c): each tile placed rigidly about its own center** (`view-frame.ts`): its ECEF content is rotated from
   the center's east, north and up axes onto the axes the frame draws there and translated to where the frame draws
   the center, all in float64 before the float32 matrix (ADR 0004). On the globe this is exactly ECEF minus the eye;
   on the flat map a 128 m tile bends by millimeters. One anchor (option b) fails for Google's tileset, whose root is a
   whole-Earth volume around the ECEF origin. Traversal gets its camera in ECEF through the frame of the view's morph
   anchor, so levels of detail follow true distances in every phase.
2. **Option (c), ε = 0.1%** (`DEPTH_PULL`, `model-meshes.ts`): 16 cm at 160 m. Without it the fixture city's ground,
   laid on the fixture terrain, showed the terrain's imagery through its streets; with it no frame does (F467). The
   cost: content within 0.1% of its distance behind another surface draws in front of it, invisible at that margin.
3. **Option (b)** (`providers/google-3d-tiles-provider.ts`): the engine and its logs see URLs without the key or the session;
   a session is used for `sessionLifetimeMs` (default 2 h 45 min, Google's last about three hours), then a new one
   starts from the root tileset; a 400, 401 or 403 starts one new session for the whole burst of refused requests and
   retries them, so no tile fails because its token expired (F469). The Google profile applies as for the 2D tiles:
   display only (picking and tile data refused through core's `refuseDisplayOnly`, `GlobeError` `display-only`, F323), no persistent cache, prefetch
   or offline packaging, Google's logo and the copyrights of the drawn tiles (their glTF `asset.copyright`, most
   frequent first).

Requests go through the page's request pool with the loader's own priority queue (`TileFetcher`, a `NetworkPool`
client), and are cancelled when traversal no longer uses their tile (a loading tile is not re-requested, so "not in
this frame's requests" alone would cancel every request each frame). Models decode with `parse-model` on the engine's
workers, with the Draco decoder's URL in each task (`dracoWasmUrl`); on an engine whose worker program lacks the task,
the loader uses a worker of the application's own (`modelWorker`), else the task table it gives (`modelTasks`) on the
main thread. KTX2 textures transcode with the worker program's `transcode-ktx2` task.

## Consequences

- `@vibeglobe/renderer/tiles3d` exports `buildModelMeshes` (a `ModelDescription` to three.js meshes, for the main
  session's glTF models, C hook 2) and `threeTileMeshes`; the loader and Google adapter live in
  `@vibeglobe/sources/tiles3d`. The renderer now depends on `@vibeglobe/models` (types only at run time).
- Render extensions need a globe with tiled imagery to receive `network` and `workers`; without them the loader
  falls back to six requests at once and the fallback task table.
- The fallback model worker bundles meshoptimizer's decoder, whose Blob-worker code built bundles refuse (F100): the
  playground starts it only on its development server; applications that pass `modelTasks` meet the same check in
  their own bundles.
- Credits of render extensions cannot reach the engine's attribution yet (hook request E (2)); the playground's
  Google scenario shows the logo and copyrights in its own pinned element meanwhile.

## Update 2026-11-01

The Google sessions and the playground's Google scenario are removed ([ADR 0185](0185-no-proprietary-provider-adapters.md)):
an application passes its own transport and profile to `tiles3d`.
