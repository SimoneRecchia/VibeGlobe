# 0017. Entries waiting only for owner-only steps

- Status: Accepted
- Date: 2026-10-20
- Milestone: M2 (amends ADR 0003 and ADR 0016)

## Context

Some feature-list entries end with a step that only the owner can perform: running a procedure on physical reference devices, using a real API key, spending money (paid services, real dataset downloads), publishing to npm, making the repository public, or a legal sign-off. The owner directed (2026-10-20) that these steps never block the work: everything up to them is prepared and verified, the pending step is recorded, and the build moves on. With only `passing` and `failing`, such an entry would read as unfinished work for the agent, and `npm run status` would point at it forever.

## Options considered

1. **Leave the entries failing:** honest, but the next-feature pointer and milestone progress stop meaning "work the agent can do".
2. **Mark them passing:** false; their final step has not been performed.
3. **A `pending` status, recorded and checked:** the entry says exactly that the owner's step is all that remains.

## Decision

Option 3.

- `pending` is a valid status for an entry whose every step that can run without the owner passes and whose remaining steps need one of the owner-only actions above. It is never used for work the agent could do.
- `docs/open-questions.md` has a "Pending owner steps" section with one row per pending entry: the entry, the owner-only step, and what was prepared. `npm run check:features` fails when a pending entry has no row or a row names an entry that is not pending.
- `npm run status` reports pending entries separately and never names one as "Next". When the owner performs the step, the entry is verified and becomes `passing`.
- A milestone is complete when each of its active entries is `passing` or `pending`; its acceptance entry may be `pending` only for the same owner-only reasons.

## Consequences

- Progress figures stay truthful: pending entries never count as passing, and the owner gets one list of everything waiting on them.
- The record adds one table and one check, like ADR 0016's.
