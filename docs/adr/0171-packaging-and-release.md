# 0171. Packaging and release: checked tarballs, consumer projects, a dry-run release and an approved CI publish

- Status: Accepted (decided by agent; owner may revisit)
- Date: 2026-10-24
- Milestone: M15

## Context

PLAN.md's distribution requirements: the public npm registry under `@vibeglobe`, semantic versioning, ESM builds with
type declarations, tree-shakeable packages, workers, WebAssembly and shader assets resolvable by Vite and Nuxt or from
configurable URLs, a changelog, version tags and publishing from CI (F503, F526, F530–F532, F535, F558, F559).
Publishing is the owner's (open question 17: the npm token and the approval of each release). Until a release is
published, consumers can only be tested with packed tarballs. Prior art: `scripts/check-consumer.ts` (the workspace's
own `dist/` through symlinks) and `apps/lazy-host` (F547); release tools surveyed: Changesets, semantic-release,
release-please and a plain script.

## Options considered

1. **Changesets or release-please**: maintained and permissive, but both want per-change files or conventional
   commits throughout, and this repository's history uses neither (`F123: …`, `Engine: …`, `Track D (M13): …`).
   They also bring their own versioning model for many independently versioned packages, where the engine releases
   all packages together.
2. **semantic-release**: version from commit messages, publishing included; the same conventional-commit
   requirement, and it decides the version itself, while the owner chooses it.
3. **A short script of our own** (`scripts/release/`): one version for every package chosen by the person releasing;
   the changelog sorted from the commit history, accepting conventional prefixes and the repository's own `F123` and
   `KB-123` conventions; publishing with `npm publish` itself.

For checking what ships: inspecting `dist/` (what `check-consumer.ts` does) misses what `npm pack` leaves out or
adds; installing the packed tarballs into projects outside the repository is what a consumer gets.

## Decision

Option 3, with these rules:

1. **Tarballs (F530).** Every published package ships `dist/`, `src/` (tests and fixtures excluded, so its source
   maps, declaration maps and `source` export condition point inside the tarball), `LICENSE.md` (a copy of the
   repository's, checked identical) and a top-level `types`. `scripts/release/check-tarballs.ts` packs every package,
   checks each tarball (ESM only, every exports target present, declarations exported, no import or source map
   reaching outside it) and type-checks `examples/strict-consumer` (strict, `skipLibCheck: false`) installed from the
   tarballs in a directory outside the repository, failing on any file it reads from elsewhere.
2. **Consumer projects (F503, F531, F532, F559).** `examples/` holds small applications built outside the repository
   from the tarballs (or, after a release, from npm): `minimal-globe` (core, renderer, sources, worker), `lazy-modules`
   (core and renderer first, each optional module behind a dynamic import) and `nuxt-globe` (the Vue adapter in
   Nuxt). `scripts/release/check-consumers.ts` serves them under F100's strict Content Security Policy (Nuxt's inline
   configuration script needs `'unsafe-inline'`; `'unsafe-eval'` is never allowed) and checks them in Chromium.
   Consumers that serve engine assets from another path build with a relative `base` (Vite's default `/` writes the
   WebAssembly's URL into the worker as `/assets/…`).
3. **Release (F526, F558).** `scripts/release/release.ts <version>` sets the version on every package and pins the
   `@vibeglobe/*` dependencies to it, adds the changelog entry, builds, runs the tarball check, commits and tags
   `v<version>`, and runs `npm publish` for every package, dependencies first, with `--access public` and the
   dist-tag `next` for pre-releases (`latest` otherwise). By default it is a dry run in a temporary git worktree
   (`npm publish --dry-run`, the tag deleted afterwards); `--publish` refuses to run anywhere but the release
   workflow's job on `main` in GitHub Actions with `NODE_AUTH_TOKEN` set.
4. **Approval (F558).** `.github/workflows/release.yml` (manual, with the version): a dry-run job, then a publish job
   only when asked, on `main`, in the `npm-release` environment, whose required reviewer is the owner and whose
   `NPM_TOKEN` secret exists only there; npm provenance through the job's OIDC token; a post-release job installs
   the published version from npm (F559). Pull requests changing the release tooling run the dry run.
5. **The skill (F535).** `.claude/skills/release/SKILL.md` drives it.

## Consequences

- No new dependencies; the changelog's categories are only as good as commit subjects, so release notes may need a
  reword in the release pull request.
- One version for all packages: a fix in one package releases all of them, simple for consumers to match.
- Owner steps: create the `npm-release` environment with the owner as required reviewer and the `NPM_TOKEN` secret,
  allow the release job to push the release commit to `main` (or change step 4 to a pull request), and approve each
  release (docs/open-questions.md, question 17).
- Found while building: `@vibeglobe/worker` depends on `@vibeglobe/layers` and `@vibeglobe/models`, so an application
  with tiled imagery installs them (F532); `@vibeglobe/renderer`'s declarations need `@types/three`, a devDependency
  (hook requests H (1) and H (2) in docs/parallel-tracks.md).
