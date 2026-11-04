# 0192. CI only on pull requests and by hand

- Status: Accepted
- Date: 2026-11-04
- Milestone: M1 (F710; partly supersedes ADR 0015 and ADR 0022 on when CI runs)

## Context

The owner's brief of 2026-11-04: the checks run on pull requests; after a pull request merges nothing starts on
`main`, nor on a push to `main`, as every change goes through a pull request whose checks already ran. CI ran on every
push (so twice for a pull request's branch), on every push to `main` with the full matrix, nightly and weekly.

## Decision

- `ci.yml` triggers on `pull_request` and `workflow_dispatch` only. A pull request runs the fast job (every non-browser
  check, the unit tests its changes reach); a manual run adds the whole unit suite with coverage, the sixteen
  end-to-end shards, the isolated measurements, Firefox and WebKit and the benchmarks.
- No workflow has a schedule; `visual-baselines.yml` keeps its push trigger on the request file for branches other
  than `main`. `package-checks.yml` runs on pull requests, `release.yml` by hand (ADR 0190).
- The fast job compares the feature list and the tests with the pull request's base.
- `scripts/checks/ci-triggers.test.ts` keeps it so.

## Consequences

- One run per pull request update instead of two, and none after the merge.
- The full matrix runs only when started by hand: run the affected end-to-end specs locally before opening or updating
  a pull request, and start a manual run for long suites.
