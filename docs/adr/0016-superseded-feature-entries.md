# 0016. Superseded feature-list entries

- Status: Accepted
- Date: 2026-10-20
- Milestone: M1 (amends ADR 0003)

## Context

ADR 0003 freezes every `feature_list.json` entry: only `status` changes, entries are never deleted, reordered or reworded, and a genuinely wrong entry gets a new appended entry while the old one passes only if its own steps pass. That rule assumes every entry can still pass.

The owner's decisions of 2026-10-20 ([ADR 0015](0015-owner-decisions-2026-10-20.md)) made nine entries impossible: their steps require a private repository named VibeGlobeEngine, a private package registry, full world and Italy dataset builds, or tilt starting as the map finishes flattening. With only `passing` and `failing`, those entries stay failing forever, so the Definition of done could never be met, or they would have to be marked passing against their own steps.

## Options considered

1. **Edit or delete the entries:** simplest, but it breaks the rule that protects the list from being rewritten to look like progress, and loses the history of what was asked.
2. **Leave them failing:** honest about their steps, but the project could never finish, and `npm run status` would always point at work that must not be done.
3. **A third status, `superseded`, recorded and checked:** the entry text stays frozen; a status change marks it replaced; a separate record names the owner decision and the replacing entries, and a check keeps the record and the list consistent.

## Decision

Option 3.

- `superseded` is a valid status. It is used only when an owner decision makes an entry impossible to pass, never because an entry is hard or failing.
- `docs/feature-changes.md` has one table row per superseded entry: the entry, its replacement entries, the owner decision (date and ADR) and why the entry can no longer pass. `npm run check:features` fails when a superseded entry has no row, when a row names an entry that is not superseded, or when a replacement does not exist or is itself superseded.
- Replacement entries are new entries with new ids, placed at the replaced entry's priority position in its milestone. They are written like any entry and then frozen.
- `npm run status` counts superseded entries separately: progress is passing over active (not superseded) entries, per milestone too, and "Next" never names a superseded entry.
- The Definition of done item "every entry in the feature list passes" and F541's step that asserts it are read as: every entry that is not superseded passes, and every superseded entry has passing replacements. Nothing else in ADR 0003 changes.

## Consequences

- Owner-driven requirement changes are recorded without rewriting history, and progress numbers stay honest: superseded entries never count as passing.
- The record adds one file and one check. Superseding an entry needs an owner decision, so it cannot happen quietly; the milestone reviews check the record.
- First use: F038, F149, F342, F347, F489, F521, F534, F536 and F539, replaced by F542–F561.
