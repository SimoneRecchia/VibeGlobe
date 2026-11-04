# 0193. CI only on pull requests and by hand

- Status: Accepted
- Date: 2026-11-04
- Milestone: M1 (F711; partly supersedes ADR 0015 and ADR 0022 on when CI runs)

## Context

The owner's brief of 2026-11-04: the checks run on pull requests; after a pull request merges nothing starts on
`main`, nor on a push to `main`, as every change goes through a pull request whose checks already ran. CI ran on every
push (so twice for a pull request's branch), on every push to `main` with the full matrix, nightly and weekly.

## Decision

- `ci.yml` triggers on `pull_request` and `workflow_dispatch` only, and is the only workflow on pull requests. A pull
  request runs one job: the build with its type check (`tsc -b`) and the unit tests its changes reach. A manual run adds
  the whole unit suite with coverage, the sixteen end-to-end shards, the isolated measurements, Firefox and WebKit and
  the benchmarks.
- Lint, format, the repository checks, dead code, the feature and test guards, the licenses, the API documentation, the
  bundle sizes and the package checks leave the pull requests: they run locally (`npm run verify`), and
  `package-checks.yml` by hand.
- No workflow has a schedule; `visual-baselines.yml` keeps its push trigger on the request file for branches other
  than `main`; `release.yml` runs on a published GitHub release (ADR 0192).
- `scripts/checks/ci-triggers.test.ts` keeps it so.

## Consequences

- One short run per pull request update instead of two long ones, and none after the merge.
- The full matrix runs only when started by hand: run the affected end-to-end specs locally before opening or updating
  a pull request, and start a manual run for long suites.
