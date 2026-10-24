# 0161. Robustness suite: playground scenarios with seeded randomness, known bugs kept apart

- Status: Accepted (decided by agent; owner may revisit)
- Date: 2026-10-24
- Milestone: M15

## Context

Track G builds M15's robustness entries (F499, F509–F517): mount and unmount cycles, soak, network and storage chaos, GPU loss, fuzzing, pixel-density changes, hidden tabs, sleep and resume. The track owns only `e2e/robustness/` and `scripts/robustness/`; engine bugs it finds go to the main session, and their tests must stay out of the default CI run until fixed. The building blocks exist: the playground's test hooks (`mount`, `simulateDeviceLoss`, `captureFrame`), the ADR 0010 leak probes (`e2e/support/leaks.ts`), the offline harness and the network suite's frame checks (ADR 0151).

## Options considered

1. **New harness pages per scenario:** full control; duplicates the playground and the offline harness.
2. **The existing pages, driven from the specs (chosen):** each spec drives the playground or the offline harness through their public hooks, with every random choice from a seeded generator (`support/probes.ts`; the seed is printed and `VIBEGLOBE_ROBUSTNESS_SEED` replays it) and counts scaled by `VIBEGLOBE_ROBUSTNESS_SCALE` for development runs.
3. **Known-bug specs behind an environment switch inside the default specs:** keeps one file; a skipped test in the default run reads as a weakened test.

## Decision

Option 2. Specs of open engine bugs are separate files named `*.bug.ts` under `e2e/robustness/known-bugs/`, matched only by `e2e/robustness/known-bugs.config.ts` (which reuses the main configuration's project and servers); the default run keeps whatever part of the scenario does not hit the bug. The aggregate fuzz suite does the same per target with `knownBugs` patterns (ADR 0162). Each exclusion is recorded in `docs/test-changes.md`, and the bug's row in `docs/known-bugs.md` names the spec that reproduces it.

Two engine limits shape the scenarios: the recovery limit of ADR 0010 §8 (at most 3 recoveries within 60 s) spaces F512's 50 losses at 3 a minute, and the page-wide worker pool, which never shrinks while an engine holds it (ADR 0011), makes "workers back to baseline" mean none left once every engine on the page is destroyed.

## Consequences

Full-length runs are long (F517's 1000 cycles, F512's 17 minutes of losses per backend): they run in CI's end-to-end jobs, and development runs use a scale of 0.1. Steps that need real devices or hours of runtime stay `failing` and are listed in `docs/hardening-backlog.md`.
