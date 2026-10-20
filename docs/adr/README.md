# Architecture Decision Records

Every significant decision is recorded here: context, options considered, decision, consequences. Performance decisions include the measurements behind them; provider-profile decisions record the reading of the provider's current terms.

Conventions:

- One file per decision, named `NNNN-short-title.md` with a four-digit sequence number. Copy [0000-template.md](0000-template.md).
- Status is one of `Proposed`, `Accepted`, `Superseded by NNNN`, `Deprecated`. Accepted ADRs are not rewritten: a changed decision gets a new ADR that supersedes the old one.
- Link the ADR from the code that implements a non-obvious decision, and from `docs/plan/` when it settles a decision marked Proposed there.

| ADR                                           | Title                                                                                                     | Status   |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------- |
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions                                                                             | Accepted |
| [0002](0002-monorepo-and-tooling.md)          | Monorepo and tooling                                                                                      | Accepted |
| [0003](0003-session-state.md)                 | Session state for a multi-session build                                                                   | Accepted |
| [0004](0004-precision-strategy.md)            | Precision strategy: camera-relative rendering with split per-draw offsets                                 | Accepted |
| [0005](0005-depth-strategy.md)                | Depth strategy: one reversed-Z float encoding, with a fragment-depth path for WebGL2 without clip control | Accepted |
| [0006](0006-level-of-detail.md)               | Terrain and imagery level of detail                                                                       | Accepted |
| [0007](0007-scheduling-and-caching.md)        | Tile request scheduler and memory caches                                                                  | Accepted |
| [0008](0008-globe-to-flat-morph.md)           | Globe-to-flat morph                                                                                       | Accepted |
| [0009](0009-camera-and-input.md)              | Camera and input                                                                                          | Accepted |
| [0010](0010-renderer-base.md)                 | Renderer base: three.js WebGPURenderer pinned to 0.186.1                                                  | Accepted |
| [0011](0011-workers.md)                       | Worker architecture                                                                                       | Accepted |
| [0012](0012-test-tooling.md)                  | Test tooling, image tolerances and benchmark method                                                       | Accepted |
