# 0191. Publishing through npm's trusted publishing, with no token

- Status: Accepted
- Date: 2026-11-04
- Milestone: M15 (F709; partly supersedes ADR 0190)

## Context

The owner's brief of 2026-11-04: the release must not use an npm token. npm's trusted publishing lets a package
trust one GitHub repository's workflow: the workflow proves who it is with GitHub's OIDC token, npm gives it a
short-lived credential for that publish, and attaches the provenance itself. It needs npm 11.5.1 or later and Node
22.14 or later, the workflow's `id-token: write` permission, and a `repository` in the published manifest that matches
the repository exactly. npm configures a trusted publisher only for a package that already exists.

## Decision

- `release.yml` keeps one job, in the `npm-release` environment (its required reviewers, when set, approve it), with
  `id-token: write`, no secret and no `NODE_AUTH_TOKEN`; it installs npm 11.21.1 (Node 22 ships npm 10) and no
  dependency cache, as npm's guide asks of release builds.
- `release.ts` refuses to publish without an OIDC identity (`ACTIONS_ID_TOKEN_REQUEST_URL`) instead of without a token,
  and drops `--provenance`: npm adds it.
- `vibeglobe`'s manifest carries `repository` (`git+https://github.com/SimoneRecchia/VibeGlobe.git`), which the pack
  copies into the published package.
- The first version is published once by hand by the owner, logged in with two-factor authentication; then
  `vibeglobe`'s trusted publisher is set on npmjs.com (GitHub Actions: `SimoneRecchia`, `VibeGlobe`, `release.yml`,
  environment `npm-release`), and the package's publishing access can require two-factor authentication and disallow
  tokens.

## Consequences

- No npm token exists in the repository's settings; the `NPM_TOKEN` secret and the token behind it can be deleted.
- A publish from anywhere but this workflow on `main` is refused by npm, not only by the script.
