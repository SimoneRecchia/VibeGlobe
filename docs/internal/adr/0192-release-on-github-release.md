# 0192. The release runs on a published GitHub release, the version from its tag

- Status: Accepted
- Date: 2026-11-04
- Milestone: M15 (F710; partly supersedes ADR 0190 and ADR 0191)

## Context

The owner's brief of 2026-11-04: the release pipeline starts when a release is created on GitHub, and takes the
version to publish from the release's name or tag. Until then the Release workflow was started by hand on `main` with
the version typed in.

## Decision

- `release.yml` runs on `release: types: [published]`; its one job checks out the release's tag and passes the tag
  (`github.event.release.tag_name`) to `release.ts`.
- `release.ts` reads the version from the tag, `v1.2.3` or `1.2.3`, and refuses a tag that names no semantic version.
  The tag rather than the release's title: GitHub requires a tag, while a title is free text.
- It refuses to publish for any event but a GitHub release, instead of any ref but `main`; npm's trusted publishing,
  the `npm-release` environment and the rest of ADR 0191 stay.

## Consequences

- Releasing is GitHub → Releases → Draft a new release → a tag such as `v0.2.0` → Publish release. A pre-release
  version (`v1.0.0-rc.1`) goes to npm's `next` dist-tag.
- What is published is the code at the release's tag, wherever it points. An `npm-release` environment limited to
  protected branches would block the job: its deployment rules must allow the release tags (`v*`).
