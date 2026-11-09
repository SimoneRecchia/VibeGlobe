# 0196. Pre-releases started by hand; releases only by the owner

- Status: Accepted
- Date: 2026-11-09
- Milestone: M15 (F715; extends ADR 0192)

## Context

The owner's brief of 2026-11-09: the agent publishes pre-releases itself when one is worth publishing, not at random;
only a release (`latest`) needs the owner's authorization. Until then every version, pre-releases included, was a
GitHub release the owner created by hand (ADR 0192), and the agent has no tool that creates one.

## Decision

- `release.yml` also runs on `workflow_dispatch`, with the version and the notes as inputs. `release.ts` publishes such
  a run only for a pre-release version (one with a `-`, to the `next` dist-tag) and only from `main`; a release that
  way is refused. A GitHub release still publishes any version (ADR 0192).
- The publishing job is the same for both: the `npm-release` environment, npm's trusted publishing, read-only
  contents. A second job, only for a run started by hand and only once npm has the version, creates the tag and the
  GitHub pre-release page (`gh release create v<version> --prerelease`). It alone may write to the repository, and it
  checks out and runs nothing, so the job that installs third-party code cannot push.
- When a pre-release is worth publishing (the agent's rule, `CLAUDE.md`): changes merged on `main` that an
  application waits for, the package checks of the release skill passed, and the next free `-rc.<n>` of the coming
  version. Not after every merge, not to try a change, never a release version.

## Consequences

- The agent starts a pre-release with the GitHub tools it has (`run_workflow` of `release.yml` on `main`), without
  the owner. npm's trusted publisher (workflow `release.yml`, environment `npm-release`) accepts both events.
- The `npm-release` environment must let the job deploy from `main`, not only from the `v*` tags. Its required
  reviewers, when set, approve each pre-release too: an owner who wants pre-releases to go out unattended leaves the
  environment without required reviewers, and keeps releases under control by being the only one to create GitHub
  releases.
- Should the page job fail after npm published the version, the version stays published (npm never reuses it) and the
  page is made by hand, or by running the job again.
