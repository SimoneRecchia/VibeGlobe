# 0026. Terrain sources: decoders, custom adapters and vertical datums

- Status: Accepted
- Date: 2026-10-22
- Milestone: M4

## Context

M4 adds terrain from three encodings (quantized-mesh, Terrarium, Terrain-RGB), any other encoding through a public adapter interface (F132), and geoid-referenced sources converted to WGS84 ellipsoidal heights (F133). [ADR 0006](0006-level-of-detail.md) §5 fixes the representation: every source is decoded in workers to a float32 height grid, and the shader and the elevation queries evaluate the same piecewise-linear function. [ADR 0011](0011-workers.md) allows only the one prebuilt worker program: no `blob:` workers and no `eval`, so code from a host page cannot run inside it. [ADR 0015](0015-owner-decisions-2026-10-20.md) says the project serves no datasets.

Open points: where the decode function of a third-party adapter runs, and where the geoid grid of F133 comes from.

## Options considered

1. **Custom decoders as worker module URLs.** The adapter names a same-origin module that the worker imports. Pros: off the main thread. Cons: the worker would import code from the page's origin at runtime, which the strict CSP (F100) and ADR 0011's single-program rule exclude; adapters become harder to write and test.
2. **Custom decoders as pure functions run by the pool's inline executor.** The adapter passes `decode(bytes, coord) → HeightGrid`; the engine runs it between frames on the main thread, in the time slice the inline executor already budgets. Pros: no new loading path, the same CSP, an adapter is one function. Cons: decoding a custom encoding costs main-thread time.
3. **Geoid grid bundled with the engine.** A 1° EGM2008 grid (about 130 KB as int16) shipped in `@vibeglobe/sources`. Cons: a dataset in the package, against ADR 0015; downloading the real grid is an owner step.
4. **Geoid grid hosted by the consumer.** The source declares `{ kind: 'geoid', model }`; a loader reads a grid file the consumer hosts (header plus int16 or float32 values). Tests use synthetic grids with analytic undulations.

## Decision

Options 2 and 4.

- Built-in decoders run in workers (F134), behind the `decode-terrain` task of `@vibeglobe/worker`, which also inflates gzip-compressed tiles. A custom decoder is a pure function the engine runs in the inline executor between frames; the terrain guide says what that costs.
- Every terrain source declares its datum. Geoid heights are converted with h = H + N, N bilinear in the consumer's grid, once per tile as it arrives decoded, before upload and elevation queries: a few thousand lookups per tile, so on the main thread and for every decoder alike. An unknown datum is rejected when the globe is created, naming the source.
- Recording the real EGM2008 grid and checking it against published undulations (F133 step 1) needs the dataset download, an owner step: F133 stays `pending` once its other steps pass, listed in `docs/open-questions.md`.

## Consequences

- Third-party adapters import only `@vibeglobe/core` types and write one function (F132's import check).
- No dataset in the repository or the packages; the geoid grid format is documented in `docs/guides/terrain.md`.
- If a custom decoder proves too slow on the main thread, a follow-up can accept worker-side WebAssembly decoders from the asset base URL, which the CSP already allows.
