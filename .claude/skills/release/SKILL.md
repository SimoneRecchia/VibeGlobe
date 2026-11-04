---
name: release
description: Release VibeGlobe: a published GitHub release builds the single `vibeglobe` package and publishes it to the public npm registry, at the version of the release's tag. Use when asked to release, publish or pack a version, or to check a published one.
---

# Release

ADR 0190: the release only builds and publishes. One package is published, `vibeglobe`, holding every engine package
under subpaths (ADR 0189). Publishing is the owner's: an agent never publishes, it may pack and run the checks.

## Publish (owner)

The workflow publishes through npm's trusted publishing (ADR 0191): GitHub's OIDC identity of `release.yml`, no npm
token anywhere. npm configures a trusted publisher only for a package that exists, so the first time:

1. Publish the first version by hand: `npm run build && npm run release:pack`, then
   `npm publish release-<version>/vibeglobe-<version>.tgz --access public`, logged in (`npm login`) with two-factor
   authentication.
2. On npmjs.com, `vibeglobe` → Settings → Trusted publisher → GitHub Actions: organization or user `SimoneRecchia`,
   repository `VibeGlobe`, workflow `release.yml`, environment `npm-release`. Then Settings → Publishing access →
   "Require two-factor authentication and disallow tokens", and delete the `NPM_TOKEN` secret and its token.

Every release after that is a GitHub release (ADR 0192):

1. Merge what goes in the release into `main`; CI green.
2. GitHub → Releases → Draft a new release → a tag naming the version, `v1.2.3` (or `1.2.3`), on `main` → Publish
   release. A pre-release version such as `v1.0.0-rc.1` goes to the npm dist-tag `next`, a release to `latest`.
3. The Release workflow's **Publish to npm** job runs on the published release, in the `npm-release` environment
   (required reviewers, when set, approve it first; its deployment rules must allow the `v*` tags) with
   `id-token: write` and npm 11.21.1. It runs `node scripts/release/release.ts <tag>`: the version from the tag,
   `tsc -b`, the Web Component's browser build, the pack (`scripts/release/tarballs.ts`, at that version) and
   `npm publish <tarball> --access public --tag <next|latest>`; npm attaches the provenance. It refuses outside that
   job (not CI, not a release, not `release.yml`, or no OIDC identity) and a tag that names no version.

Nothing else happens: no changelog or commit. npm refuses a version that was already published: choose the next.

## Before and after (agent or owner)

```sh
npm run build && npm run release:pack          # release-<version>/vibeglobe-<version>.tgz, to install from the file
node scripts/release/check-tarballs.ts         # F519, F530: the tarball's content, a strict consumer type-checks
node scripts/release/check-consumers.ts F503 F531 F702 F703   # consumer projects from the tarball in Chromium
node scripts/release/check-consumer-names.ts   # F559: no consumer application named
node scripts/release/check-consumers.ts --registry <version>  # after publishing: the same consumers from npm
```

The **Package checks** workflow runs the first four on pull requests that change the packaging. Set
`VIBEGLOBE_CHROMIUM_PATH=/opt/pw-browsers/chromium` in cloud containers. After publishing, `npm view vibeglobe@<version>`
shows the version under its dist-tag.
