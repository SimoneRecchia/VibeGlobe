# 0022. A faster process for the remaining milestones

- Status: Accepted
- Date: 2026-10-21
- Milestone: every milestone (process), from M3; extends [ADR 0021](0021-milestone-review-closure.md)

## Context

M2 closed after nine complete reviews and two incremental ones, with the whole browser suite run on one machine after every round. Thirteen milestones remain. The owner made the repository public on 2026-10-21, so GitHub-hosted runners are free and parallel jobs cost nothing, and on the same day set four process changes that remove waiting without removing checks.

## Decision

1. **Reviews.** Each milestone gets one complete fresh-context review, then one pass that checks only the fixes of that round and their interactions with nearby code. Findings keep ADR 0021's severities. Every fix starts with a regression test that fails before it. There are no further complete review rounds: this replaces ADR 0021 §4 and §5 (up to three incremental reviews and a final complete one). What the fix pass finds is fixed, each with its regression test, in the same round, and the milestone closes once the full suite is green on the final head. ADR 0021 §6 is unchanged: `npm run verify` before every push, no known bug open at the end of a milestone, no weakened test, no merge until everything is green.
2. **End-to-end tests.**
   - CI splits the Chromium suite across parallel jobs by test file: four at first, eight since 2026-10-22, each running one test at a time (`playwright test --shard=i/8 --workers=1`), because two tests rendering at once on the software GPU slowed each other's frames past their time limits.
   - During feature work only the end-to-end tests the change affects run locally: the specs of the features touched, and the specs of the modules changed (`npx playwright test <spec files>`, `-g <feature id>`).
   - The full suite runs at the end of each milestone (a manual CI run on the final head) and nightly; pushes to `main` run it too, as before.
3. **Isolated measurements.** The tests that measure the whole machine (the `measurements` Playwright project: heap sampling and GC traces, F064) and ADR 0012's rendering probes move to a dedicated CI job, `Isolated measurements`, on its own runner. They never share a machine with another test and never hold up feature work: no shard waits for them and no feature commit is gated on them. A red measurement is still a bug: it is listed in `docs/known-bugs.md` and fixed before the milestone closes. Locally they run only with the CPU otherwise idle (`npx playwright test --project=measurements --no-deps`), never next to another measurement. The recorded benchmarks keep their own job.
4. **Parallel work.** Subagents work in separate packages or separate files, so their changes cannot regress each other or the work in progress; they create files and never commit. After each one finishes, its work is integrated, checked like any other change (lint, type check, its unit tests and the tests of the code it touches) and committed on its own.

## Consequences

- A milestone costs two review passes instead of up to five, and the regression tests written for each fix carry the guard against regressions that further rounds used to provide.
- The browser suite takes about a quarter of its wall-clock time in CI, and its timing-sensitive tests no longer share a machine with the measurements.
- A regression in an end-to-end test that a change did not obviously touch can go unnoticed until the end of the milestone or the nightly run. It is still caught before the milestone closes, and its fix starts with a failing test as usual.
- `CLAUDE.md` states these rules for every session.

## Update 2026-10-21: working efficiently

The owner added rules for the rest of the project (CLAUDE.md, "Working efficiently"): scope limited to `PLAN.md` and `feature_list.json`, everything else to `docs/follow-ups.md`; one focused test per stated behavior; only affected tests run during work, full suites once per milestone and in CI; no extra verification passes or double-checking subagents; at most two subagents (`.claude/settings.json`: `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=2`, `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1`), only for large independent work; `progress.md` records features, hours and an estimate to M15 at each milestone end. CI: pull requests run only the unit tests their changes reach (`vitest run --changed <base>`); every job restores the incremental build outputs and the Playwright browsers from the Actions cache; the full matrix stays on `main`, nightly and manual runs.
