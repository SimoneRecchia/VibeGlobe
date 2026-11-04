# 0189. One npm package: `vibeglobe`, the engine packages inside it under subpaths

- Status: Accepted
- Date: 2026-11-04
- Milestone: M15 (F702, F703, F704; supersedes ADR 0171's one package per engine package, carries out ADR 0186's
  packaging option (b))

## Context

The owner's brief of 2026-11-04: VibeGlobe is published as one npm package. An application installs one thing and
starts the globe in one call; the bundler must still take only what is imported, so an application's bundle does not
grow. ADR 0186 chose the layout, option (b): the workspace packages stay the units the code is built and tested in, and
one package holds their builds under subpaths. The release scripts still packed and published the fifteen engine
packages one by one under `@vibeglobe`.

## Decision

- Every engine package under `packages/` is private: it keeps its tests, budget, rules and `@vibeglobe/<name>` name
  inside the repository, and is never published alone. Every one of them carries the release's version.
- `scripts/release/tarballs.ts` packs `vibeglobe`: the facade at the root, every other engine package's published files
  under its folder (`core/`, `renderer/`, `layers/`, …), the guides, `docs/data-licenses.md` and `llms.txt`. Each
  package's exports become subpaths (`vibeglobe/core`, `vibeglobe/layers/vector-tiles`, `vibeglobe/worker/basic`, …),
  without the workspace's `source` condition, and the tools' command stays `vibeglobe-data`.
- Inside the package, `@vibeglobe/<name>` imports become the package's own `vibeglobe/<name>` subpaths (Node's package
  self-reference), so nothing is resolved from outside it. Its dependencies are the engine packages' third-party ones;
  `vue` is an optional peer dependency.
- The release publishes that one tarball (`npm publish <tarball>`); the consumer checks install it alone. F532's
  "installs only some packages" becomes F703: the bundle of an application that imports only the core, the renderer,
  one source and the basic worker holds none of the other modules, checked on its source maps.
- The public documentation imports `vibeglobe/<name>`; the guides' type check resolves those subpaths to the workspace
  packages.

## Consequences

- One install (`npm install vibeglobe`), 4.2 MB packed; an application's bundle is the same as with separate packages,
  as every module is still its own file and side-effect free.
- The package budgets stay per engine package (`npm run size`), as before.
- Applications that used `@vibeglobe/<name>` change the prefix of their imports to `vibeglobe/<name>`.
