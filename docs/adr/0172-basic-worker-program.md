# 0172. A basic worker program, so applications with imagery and terrain install no data-layer packages

- Status: Accepted (decided by agent with the owner's go-ahead of 2026-10-24; owner may revisit)
- Date: 2026-10-24
- Milestone: M15

## Context

F532: an application with only the core, the renderer and one imagery source must work without the other packages
installed, and its installation must pull no layers, UI, offline, Vue or Web Component package. Tiled imagery and
terrain need `GlobeOptions.workers`, `createWorkers()` of `@vibeglobe/worker`, and the worker package listed
`@vibeglobe/layers` and `@vibeglobe/models` as dependencies: its single program (ADR 0011) registers the clustering and
vector-tile layout tasks of `layers` and the glTF parsing of `models`. Those tasks are already dynamic imports, but a
bundler resolves every import of the program it emits, so the packages must be installed even when unused. ADR 0011
rule 5 keeps one literal `new Worker(new URL('./vibeglobe-worker.js', import.meta.url))` per program so bundlers find it.

## Options considered

1. **Optional peer dependencies only**: `layers` and `models` stop being installed, but every build of an application
   that imports `createWorkers` fails on the program's unresolved imports.
2. **A variable import specifier with a bundler ignore comment**: the build passes without the packages, but with
   them installed the program asks the browser for a bare specifier, which fails.
3. **A second, basic program**: `@vibeglobe/worker/basic` exports the same `createWorkers`, starting
   `vibeglobe-worker-basic.js` with the tasks that need only `core` and `sources` (image, terrain and KTX2 decoding,
   the vector parsers); the main entry keeps the full program. `layers` and `models` become optional peer
   dependencies of the worker package.

## Decision

Option 3. `src/basic-tasks.ts` holds `BASIC_TASKS`; `src/tasks.ts` spreads it into `TASKS` with the `layers` and
`models` tasks; `src/factory.ts` holds the endpoint factory both entries share, so each entry adds only its own
literal worker URL and a bundler emits only the program the application imports. Applications with data layers,
vector tiles or glTF models install `@vibeglobe/layers` and `@vibeglobe/models` (the Vue adapter, the Web Component
and the UI already depend on them) and use the main entry; the others may use `@vibeglobe/worker/basic`.
`packages/worker/src/basic.test.ts` checks that the basic program's module graph imports neither package;
`node scripts/release/check-consumers.ts F532` checks the installed packages and the running globe.

## Consequences

- One more prebuilt program to keep in step with the protocol (both register through `createTaskHost`).
- An application that imports the main entry without `layers` and `models` installed fails at build time, as before
  their move; the error names the missing package.
