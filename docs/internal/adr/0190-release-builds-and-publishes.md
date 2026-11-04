# 0190. The release only builds the package and publishes it

- Status: Accepted (partly superseded by [ADR 0191](0191-npm-trusted-publishing.md): no token, npm's trusted publishing)
- Date: 2026-11-04
- Milestone: M15 (F708; partly supersedes ADR 0171)

## Context

The owner's brief of 2026-11-04: the release pipeline only builds the npm package and publishes it. ADR 0171's release
set a version on every package, wrote a changelog entry from the commits, ran a dry run with the tarball and consumer
checks, created and pushed a release commit and tag, published, then installed the published packages again. Its
first run stopped on a changelog entry already written for 0.1.0.

## Decision

- `.github/workflows/release.yml` is started by hand with a version and has one job, **Publish to npm**, in the
  `npm-release` environment that holds the `NPM_TOKEN` secret (its required reviewers, when the owner sets them,
  approve the job first).
- `scripts/release/release.ts <version>` builds the engine (`tsc -b` and the Web Component's browser build), packs
  `vibeglobe` at that version and publishes the tarball with public access, the dist-tag of the version (`next` for a
  pre-release) and provenance. It still refuses to run outside that job on `main` or without the token.
- No changelog (`scripts/release/changelog.ts` and `CHANGELOG.md` are gone), no version written in the repository, no
  commit, no tag, no dry run and no post-release job. npm refuses a version already published.
- The package checks (the tarball, the consumer projects, the consumer name search) move to `package-checks.yml`, on
  pull requests that change the packaging; `check-consumers.ts --registry <version>` stays to run by hand after a
  release.

## Consequences

- A release is one click and one approval; what it publishes is what `main` holds at that moment.
- The repository's versions are not the published ones: npm is the record of what was released.
