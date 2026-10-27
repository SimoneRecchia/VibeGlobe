# 0042. Core bundle budget: 64 KB gzip

- Status: Accepted
- Date: 2026-10-24
- Milestone: M15 (affects M5, M7, M11)

## Context

`@vibeglobe/core` had a 60 KB gzip budget (`quality/budgets.json`, checked by `npm run size`). By 2026-10-24 it stood at 59.79 KB after two exports had moved to subpath entry points (`@vibeglobe/core/diagnostics`, `@vibeglobe/core/layers`). Three requirements still needed core code: tone harmonization of source chains (F249), the fog-aware detail comparison and its savings (F395), and the fix of KB-153's tilt jump (F167). The agent may not loosen a quality gate on its own, so the question went to the owner (open question 29).

## Options considered

1. **Raise the budget to 64 KB.** Room for the three features and the review fixes still to come in M15. Costs every application up to 4 KB more over the network.
2. **Move more of the main entry to subpaths.** An API change for every consumer, and the saving is small: what remains in the main entry is what every globe needs.
3. **Leave F249 and F395 for after M15.** Leaves M7 and M11 incomplete.

## Decision

Option 1, the owner's decision of 2026-10-24: the budget is 64 KB gzip. The size check stays blocking; any further raise needs the owner.

## Consequences

- `quality/budgets.json` `packages.core.bundleGzipKB` is 64, recorded in `docs/test-changes.md`.
- F249, F395 and the KB-153 fix proceed in core.
- The subpath entry points stay as they are.
