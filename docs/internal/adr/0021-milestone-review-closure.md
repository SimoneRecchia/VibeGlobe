# 0021. Closing a milestone's reviews

- Status: Accepted; §4 and §5 replaced by [ADR 0022](0022-faster-milestone-process.md) from M3
- Date: 2026-10-21
- Milestone: every milestone (process), from M2

## Context

The working method required fresh-context milestone reviews until a review found nothing. On M2 that took nine reviews: each round's fixes changed shared code (the frame loop, recovery, the canvas), and the next review found a few new issues, most in those fixes and some only theoretical. The owner set a closure criterion on 2026-10-21 that keeps the quality gates and bounds the loop.

## Decision

1. **Severity.** Every finding is classified:
   - **High:** wrong behavior in realistic cases, lost data or resources, a crash, or a requirement of a passing feature that is not met or not tested.
   - **Medium:** wrong behavior in plausible but uncommon cases, or a test that cannot fail or does not check what it claims.
   - **Low:** theoretical cases or no visible effect today, numeric imprecision without impact, documentation.
2. **Clean review.** A review is clean when it finds no high or medium finding.
3. **Low findings** are fixed in the same round, each with a regression test that fails before the fix. They do not start another review. A low finding that is an improvement rather than a bug goes to `docs/internal/follow-ups.md`.
4. **Incremental reviews.** After a milestone's first complete review, later reviews are incremental: the reviewer looks only at the last round's fixes and their interactions with nearby code, where fixes cause regressions.
5. **Cap.** At most three incremental reviews follow the first complete one. If the third still finds high or medium findings, they are fixed and one final complete review runs; what it finds is fixed, and the milestone closes.
6. **Unchanged:** a failing regression test before every fix; `npm run verify` before every push; the full suite green in CI on the final head before closing; no known bug open at the end of a milestone; no weakened tests; no merge until everything is green.

## Consequences

- Reviews stay as thorough where regressions are likely (the last fixes) and stop being an unbounded loop over theoretical cases.
- Low findings are still fixed and tested, so the bar for correctness does not drop; only the trigger for another review changes.
- Applied first to M2: reviews one to nine were complete reviews; the ninth found one medium finding (KB-059) and two low ones (KB-060, KB-061), so incremental reviews follow from the tenth.
