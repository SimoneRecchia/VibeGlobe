---
name: release
description: Release VibeGlobe: build the single `vibeglobe` package and publish it to the public npm registry from the Release workflow. Use when asked to release, publish or pack a version, or to check a published one.
---

# Release

ADR 0190: the release only builds and publishes. One package is published, `vibeglobe`, holding every engine package
under subpaths (ADR 0189). Publishing is the owner's: an agent never publishes, it may pack and run the checks.

## Publish (owner)

1. Merge what goes in the release into `main`; CI green.
2. GitHub → Actions → **Release** → Run workflow on `main` with the version (semantic; a pre-release such as
   `1.0.0-rc.1` goes to the npm dist-tag `next`, a release to `latest`).
3. The **Publish to npm** job runs in the `npm-release` environment, whose `NPM_TOKEN` secret is an npm token that can
   publish `vibeglobe` (required reviewers, when set, approve it first). It runs `node scripts/release/release.ts
<version>`: `tsc -b`, the Web Component's browser build, the pack (`scripts/release/tarballs.ts`, at the version
   given) and `npm publish <tarball> --access public --tag <next|latest> --provenance`. It refuses outside that job
   (not CI, not `main`, not `release.yml`, or no token).

Nothing else happens: no changelog, commit or tag. npm refuses a version that was already published: choose the next.

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
