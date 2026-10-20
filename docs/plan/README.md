# VibeGlobe technical plan

This is the implementing agent's detailed technical plan, derived from the owner's master brief in [`PLAN.md`](../../PLAN.md). `PLAN.md` states what must be built and the fixed constraints; these documents state how.

| Document                           | Contents                                                                                                                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md) | Packages and dependency rules, runtime model, coordinate systems and precision, depth, tiling and level of detail, loading pipeline, network and offline, renderer, layers, controls, threading, errors, observability |
| [api.md](api.md)                   | Key data structures and public API sketches: engine facade, camera and view modes, sources and provider profiles, cache and network policy, layers, offline packages, events, framework adapters                       |
| [milestones.md](milestones.md)     | Task breakdown per milestone, in build order, with research prerequisites and expected ADRs                                                                                                                            |
| [quality.md](quality.md)           | Reference devices, performance and memory budgets, visual-defect metrics, testing strategy and tooling                                                                                                                 |

Related state:

- [`feature_list.json`](../../feature_list.json): every requirement as an end-to-end behavior with proof steps and a status. `npm run status` summarizes it.
- [`progress.md`](../../progress.md): session log and next steps.
- [`docs/feature-changes.md`](../feature-changes.md): feature-list entries superseded by owner decisions, with their replacements (ADR 0016).
- [`docs/adr/`](../adr/): Architecture Decision Records.
- [`docs/research/`](../research/): the mandatory research survey, one file per problem area.
- [`docs/open-questions.md`](../open-questions.md): items only the owner can provide.

## Status of the decisions in this plan

Decisions marked **Decided** are recorded in an ADR and in force. Decisions marked **Proposed** are the starting design: the research survey for that area (see `docs/research/`) must confirm or replace them before the subsystem is built, and the outcome is recorded in an ADR. When this plan and an accepted ADR disagree, the ADR wins and this plan is updated.

## Priorities

As in `PLAN.md`, in order: zero visible glitches and extreme performance; compatibility with every map and supported system; generality and modularity; feature breadth. A stutter, flicker, seam or inconsistency is a bug.
