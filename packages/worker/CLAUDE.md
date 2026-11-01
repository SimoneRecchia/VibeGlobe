# @vibeglobe/worker

The single prebuilt worker program of the page-wide worker pool (ADR 0011): `src/vibeglobe-worker.ts` is the module worker entry that answers the handshake and runs the built-in tasks; `createWorkers()` (`src/index.ts`) returns the `WorkerEndpointFactory` that core's pool (`packages/core/src/scheduler/worker-pool.ts`) uses to start it.

Two programs (ADR 0172): `vibeglobe-worker.js` (every task, entry `src/index.ts`) and `vibeglobe-worker-basic.js` (imagery, terrain, KTX2 and vector parsers only, entry `src/basic.ts`, export `@vibeglobe/worker/basic`); `@vibeglobe/layers` and `@vibeglobe/models` are optional peer dependencies, imported only by `src/tasks.ts`.

## Rules

- Workers start only with the literal `new Worker(new URL('./vibeglobe-worker.js', import.meta.url), { type: 'module', name: 'vibeglobe' })`, so bundlers find the entry, or from a configured URL that must be same-origin. Never `blob:` or `data:` workers, `eval`, `new Function` or a CDN.
- Tasks (`src/tasks.ts`) are pure functions `(input, context) → { output, transfer }`: inputs and outputs are `ArrayBuffer`s, typed arrays, `ImageBitmap`s and small plain objects, always transferred. They check `context.isCancelled()` between stages and fail with a `TaskError` code.
- `src/protocol.ts` mirrors core's `scheduler/worker-protocol.ts`; change both together and bump `WORKER_PROTOCOL_VERSION` for an incompatible change.
- Nothing on the main thread imports `vibeglobe-worker.ts` (it installs the global message handler); the inline executor imports `tasks.ts`.
- The package compiles against the DOM library; the worker entry types the small part of the worker scope it uses, since the `WebWorker` library cannot be combined with DOM.

## Commands

- `npm test` (root) runs this package's tests; tests sit next to the code as `*.test.ts`.
- `npm run build` (root) builds it with `tsc -b` to `dist/` (ESM + declarations).

See the root `CLAUDE.md` for the workflow and `docs/internal/plan/architecture.md` for where this package fits.
