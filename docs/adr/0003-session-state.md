# 0003. Session state for a multi-session build

- Status: Accepted
- Date: 2026-10-20
- Milestone: M1

## Context

The build spans many sessions and context windows. `PLAN.md` (Working method) requires all state to live in files and git: a structured feature list whose entries never change except their status, progress notes, an init script and a concise CLAUDE.md, following Anthropic's published practice for long-running agents.

## Options considered

1. **Feature list as JSON** (one object per end-to-end behavior) vs Markdown checklists: JSON is harder to rewrite casually, easy to validate and summarize by script.
2. **Status as a boolean vs a string:** a string (`"failing"` / `"passing"`) is explicit and validated by `npm run status`.
3. **Priority as a field vs file order:** a numeric priority invites reshuffling; file order (milestone order, then dependency order inside a milestone) is stable and unambiguous.

## Decision

- `feature_list.json` holds `milestones` (number → name) and `features`. Each feature has `id` (`F001`…, never reused), `milestone`, `section` (the `PLAN.md` heading it comes from), `description`, `steps` (how it is proven end to end) and `status`. Only `status` ever changes; entries are never deleted, reordered or reworded. A genuinely wrong entry is not edited: a new entry is appended to the same milestone with a note in `progress.md`, and the old one is marked passing only if its own steps pass.
- File order is priority order: the next feature to work on is the first failing entry, as printed by `npm run status`.
- An entry becomes `passing` only after its steps pass end to end in a real browser (with screenshots for visual behavior) plus the automated tests.
- `progress.md` holds the current state, the session log (newest first) and next steps. `init.sh` installs, builds, starts the playground and runs the unit and end-to-end tests. `CLAUDE.md` holds commands, conventions and gotchas.

## Consequences

Progress is measurable at any time (`npm run status`), and a fresh session can resume from the repository alone. Appending instead of editing keeps history honest at the cost of occasional near-duplicate entries.
