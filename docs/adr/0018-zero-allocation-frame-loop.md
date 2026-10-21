# 0018. A frame loop without garbage

- Status: Accepted
- Date: 2026-10-21
- Milestone: M2 (F064)

## Context

PLAN.md requires that per-frame code allocates nothing, so garbage collection never causes a stutter (F064). Measured at the start of F064, a frame of continuous drag allocated about 1.3 KB in the engine and about 11 KB inside three.js. Three findings shaped the decision; all were measured with V8's sampling heap profiler (including collected objects) in Node 22 and in Chromium 141.

1. **V8 boxes doubles at call boundaries.** A double passed to, or returned from, a function call that the optimizing compiler did not inline becomes a new heap number. Whether a call is inlined depends on budgets the engine cannot control in a browser. With TurboFan's inlining budget raised, the engine's garbage disappeared; with the default budget, `Camera.update`, the tile bounding spheres and the drag solver produced most of it.
2. **Builtins are calls in V8's mid tier.** Chrome's Maglev compiler (where code runs for a minute or more at 30 frames per second, before TurboFan) calls `Math.max`, `Math.min`, `Math.imul`, `Math.hypot` and `Number.isFinite` as builtins. It loads double fields unboxed, so it boxes each argument again. `Math.hypot` allocates even in TurboFan code (about 64 bytes per call in Node 22).
3. **`Map` boxes large number keys.** Surface tile keys exceed 31 bits from level 16 on, so every `Map` lookup by tile key allocated.

three.js 0.186 (ADR 0010) allocates internally on every render: render-object cache keys, uniform update ranges and render lists. The engine cannot remove this without patching the library.

## Options considered

1. **Rely on the optimizing compiler:** keep ordinary code and assume inlining. Rejected: the garbage was measured, and it changes with browser versions.
2. **Doubles never cross a call boundary in per-frame code:** inputs and results travel in preallocated `Float64Array`s or object fields; integers, objects and booleans pass freely. Hot builtins are replaced by comparisons and integer arithmetic, and a typed-array hash map replaces `Map` for tile keys.
3. **Replace three.js with an engine-owned renderer** to remove the library's garbage too. Rejected for M2: it reverses ADR 0010, and the library's garbage does not produce long pauses (below).

## Decision

Option 2, with these rules for the frame path (selection, cache, camera, drag solver, renderer glue):

- Functions take and return integers, booleans, objects and typed arrays. Double inputs come from typed arrays or object fields; double results go to typed arrays or object fields. Public functions with double parameters (`geodeticToEcef`, `ecefToGeodetic`, `enuFrame`) keep their form for API users and delegate to array forms (`geodeticArrayToEcef`, `ecefArrayToGeodetic`, `enuFrameAtArray`).
- No `Math.hypot`, `Math.max`, `Math.min`, `Math.imul`, `Math.abs` or `Number.isFinite` on the frame path. Comparisons and `x − x === 0` replace them. `Math.sin`, `cos`, `tan`, `atan2`, `sqrt` and `cbrt` are fine: every tier compiles them inline.
- Tile keys live in `IntegerKeyMap` (`collections/integer-key-map.hot.ts`): open addressing over a `Float64Array`. Per-frame operations read the key as an element of an array the caller holds.
- The frame callback is the bound `frame` method, not a wrapper function: a function called once per frame takes minutes to reach the optimizing tier.
- three.js's lighting system is switched off (every material is unlit). With it on, the library rebuilds the lights node's cache key on every render, about 5 KB per frame.
- Slow paths may allocate: building a tile mesh, cache eviction, the drag solver's pole fallback, wrapping a longitude across the antimeridian, and API calls that return new objects.

How F064's steps are verified:

- **Engine code allocates zero bytes per frame.** In Node (`packages/core/src/globe/frame-allocation.test.ts`, in every CI run), 20,000 frames of drag at orbit and at street level allocate less than half a byte per frame in engine sources. Any per-frame object would cost at least 12 bytes; what remains is the test runner's module plumbing. In Chromium (`e2e/globe-allocation.spec.ts`), after a 120 s warm-up at 30 frames per second, engine sources allocate less than one boxed number per frame beyond what an empty `requestAnimationFrame` callback costs (the browser boxes the timestamp passed to every callback).
- **No garbage-collection pause can cause a stutter.** The library's garbage (about 5.6 KB per frame after the change) still triggers collections, so the trace cannot be free of GC events while three.js renders. Decided by the agent (the owner may revisit, `docs/open-questions.md`): "no GC pause" means no main-thread collection pause of 8 ms or more (half a 60 Hz frame) in 60 s of steady-state motion. Measured on CI's software GPU: scavenges of at most 3 ms, and at most one major-GC finalization of about 5 ms per minute. A budget of 8 KB per frame of library garbage stops the library's share from growing unnoticed.

## Consequences

- Hot-path code is more explicit about where doubles live. The rules are stated in the hot modules' headers and enforced by the two allocation tests rather than by lint.
- `IntegerKeyMap` replaces `Map` wherever tile keys are looked up per frame, in the renderer as well.
- The remaining garbage belongs to three.js. Removing it (patched cache-key paths of the pinned version, or an engine-owned renderer) is a follow-up, measured by the same test.
- The Chromium test takes about four minutes and runs in the full suite (main and nightly), not on pull requests (ADR 0015).

## Update 2026-10-21

The precision and depth work of the M2 review (ADR 0004 and 0005 updates) added per-frame work in the renderer, measured with the method above:

- **Split offsets.** Writing T_hi and T_lo into `Vector3` fields boxed every double (three.js's vector fields hold any value); a class of the engine's own with double fields still allocated now and then. They now go into the mesh's world-matrix array, which three.js uploads per object anyway.
- **Near plane.** The camera's `near`, read by three.js as a number uniform, is written only on the fragment depth path and only when it changes.
- **Node-frame clock.** Each frame the renderer advances only three.js's node-frame id; advancing its clock stored three doubles (three heap numbers per frame) for `time` and `deltaTime`, which no engine material reads.
- **Texture-view shim.** It cleared the identity swizzle by copying the descriptor on every call, one object per frame (KB-026).
- **Measurement.** Repeated runs of unchanged code showed the browser measurement is unstable: V8 sometimes counts three.js strings and buffers (72 bytes to several kilobytes) against the outermost JavaScript function, the engine's frame callback, which made it read 7 to 22.5 bytes per frame. The test now sums samples individually and gives that function's samples over 32 bytes, and the shim's samples (the native view object three.js requests), to the library. Boxed numbers and small objects still count against the engine (`docs/test-changes.md`).
