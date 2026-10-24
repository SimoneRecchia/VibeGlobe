---
name: release
description: Release the @vibeglobe packages: version bump, changelog, version tag, publishing to the public npm registry from CI after the owner's approval, and the post-release checks. Use when asked to prepare, dry-run, cut or publish a release, bump the version, update the changelog, or check a published version.
---

# Release

Releases follow ADR 0171. One version for every published package (`packages/*` without `"private": true`), semantic versioning; a pre-release (`1.0.0-rc.1`) goes to the npm dist-tag `next`, a release to `latest`. Publishing is the owner's: it happens only in the release workflow's publish job, on `main`, after the owner approves it in the `npm-release` environment, with the `NPM_TOKEN` secret of that environment (docs/open-questions.md, question 17). An agent runs dry runs only and never publishes. Run every command from the repository root.

## 0. Before a release

- `npm run status`: the release gate (PLAN.md) is no open known bug (`docs/known-bugs.md`) and the milestone's entries passing or pending owner steps.
- `main` is green in CI, the working tree is clean (`git status`), and `npm run verify` passes.
- Pick the version: breaking changes since the last tag (`git log v<last>..HEAD`, look for `!:` and `BREAKING CHANGE:`) raise the major (the minor before 1.0.0), features the minor, fixes the patch.

## 1. Dry run (always first)

```sh
npm run build
node scripts/release/release.ts 1.0.0-rc.1          # the version to release
```

It works in a temporary git worktree of `HEAD`, so this checkout and its branch stay untouched, and it:

1. **Version bump:** sets the version on every published package and pins their `@vibeglobe/*` dependencies to it; refreshes `package-lock.json`.
2. **Changelog:** adds the version's entry to `CHANGELOG.md` from the commits since the last `v*` tag (`scripts/release/changelog.ts`): categories from conventional prefixes (`feat:`, `fix:`, `perf:`, `docs:`) or what a commit names (`F123` features, `KB-123` fixes); breaking changes (`!:`, `BREAKING CHANGE:`) marked **Breaking** and listed first.
3. **Build and package checks:** `npm ci`, `tsc -b`, the Web Component's browser build, then `scripts/release/check-tarballs.ts` (F530): every tarball holds ESM JavaScript, declarations, an exports map whose targets exist and `LICENSE.md`, and a strict TypeScript consumer type-checks against the tarballs alone.
4. **Tag:** commits `Release v<version>` and creates the annotated tag `v<version>` on it, checks the tag points at the release commit, and deletes the tag at the end (nothing is pushed).
5. **Publishing, dry:** `npm publish --dry-run --access public --tag <next|latest>` for every package, dependencies first, and checks each would be `@vibeglobe/<name>@<version>` on `https://registry.npmjs.org/`.

It writes `.release/report.json` (what would be published), `.release/CHANGELOG-entry.md` and `.release/CHANGELOG.md`. Read the entry: a commit in the wrong category or a missing **Breaking** mark is fixed by rewording the release notes in the release PR, not by editing history.

Then the consumer projects, from the same tarballs:

```sh
node scripts/release/check-consumers.ts F503 F531        # lazy modules, asset loading (Vite, Nuxt)
node scripts/release/check-consumers.ts F532             # minimal install: fails until hook request H (1) lands
node scripts/release/check-cube.ts                         # nothing refers to Cube (F559)
```

`check-consumers.ts` builds `examples/*` outside the repository, installs the packed tarballs (third-party dependencies from the public registry, no credentials), and checks them in Chromium under a strict Content Security Policy. Set `VIBEGLOBE_CHROMIUM_PATH=/opt/pw-browsers/chromium` in cloud containers.

## 2. Release (owner)

1. Merge everything for the release into `main`; CI green.
2. GitHub → Actions → **Release** → Run workflow on `main`, with the version and **publish** checked.
3. The **Release dry run** job repeats step 1 in CI. The **Publish to npm** job then waits for the owner's approval in the `npm-release` environment (Settings → Environments → `npm-release`: required reviewer the owner, secret `NPM_TOKEN` an npm automation token of the `vibeglobe` organization).
4. On approval it runs `node scripts/release/release.ts <version> --publish`, which refuses outside that job (not CI, not `main`, not `release.yml`, or no token): the same steps, `npm publish --provenance`, then pushes the release commit and the tag to `main`.

## 3. Post-release checks

The **Post-release checks** job runs after publishing; to repeat it by hand:

```sh
node scripts/release/check-consumers.ts --registry 1.0.0-rc.1
```

It installs the published packages from npm into a fresh project with no `.npmrc`, no registry configuration and no token (F559), builds it and checks the globe renders and navigates, with the worker and WebAssembly loading. Also check `npm view @vibeglobe/core@<version>` shows the version under the right dist-tag, the GitHub tag exists, and `CHANGELOG.md` on `main` has the entry. Record the release in `progress.md`.

## Pitfalls

- A tag that already exists stops the run: versions are never reused. A failed publish after some packages went out is finished by re-running the publish job (npm refuses republishing an existing version, so publish the rest by hand from CI) or by releasing the next patch.
- The dry run needs network access to the npm registry for `npm ci` and `npm publish --dry-run`; it needs no npm login.
- Consumers using TypeScript install `@types/three` until `@vibeglobe/renderer` declares it (docs/parallel-tracks.md, hook request H (2)).
