# VibeGlobe

Optimized, glitch-free web globe and map engine (TypeScript, WebGPU with WebGL2 fallback). `PLAN.md` is the owner's master brief; `docs/plan/` is the technical plan.

## Start of every session

1. Read `progress.md`, run `npm run status`, and `git log --oneline -20`.
2. Run `./init.sh` (install, build, start playground on :5173, unit + e2e tests). Fix anything broken before new work.
3. Work on the first failing feature that `npm run status` prints as "Next", and only that one.
4. Mark it `"passing"` in `feature_list.json` only after its steps pass end to end in a real browser (Playwright, screenshots for visual behavior) plus the automated tests.
5. Run `npm run verify`, commit, update `progress.md`, leave the tree clean (builds, tests pass, nothing half-done).

## Commands

| Command                               | What                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `./init.sh`                           | Install, build, start the playground (log `.playground.log`), run all tests, print status     |
| `npm run build`                       | `tsc -b` for every package + Vite build of the playground                                     |
| `npm test` / `npm run coverage`       | Vitest; coverage minima in `quality/coverage.json`                                            |
| `npm run test:e2e`                    | Playwright tests against the playground and the docs site (starts both if needed)             |
| `npm run verify`                      | Everything CI checks except browser tests: types, lint, format, repo checks, guards, licenses |
| `npm run lint` / `npm run format`     | ESLint / Prettier                                                                             |
| `npm run bench`                       | Benchmark scenarios vs `quality/budgets.json` (needs `npm run build`)                         |
| `npm run docs` / `npm run docs:serve` | TypeDoc site in `docs-site/`, served on :5174                                                 |
| `npm run notices`                     | Regenerate `THIRD_PARTY_NOTICES.md` after changing runtime dependencies                       |
| `npm run status`                      | Passing/failing counts of `feature_list.json`, per milestone, and the next feature            |

## Rules that differ from defaults

- `feature_list.json`: only the `status` field ever changes. Never delete, reorder or reword entries (ADR 0003; `npm run check:features`). An entry an owner decision made impossible becomes `superseded`, recorded with its replacements in `docs/feature-changes.md` (ADR 0016). An entry whose only remaining steps need the owner (devices, real keys, money, publishing, making the repository public, legal sign-off) becomes `pending`, listed in `docs/open-questions.md` (ADR 0017).
- Never remove, skip or weaken a test, and never loosen `quality/*.json`. A genuinely wrong test or gate is fixed with the reason logged in `docs/test-changes.md` (`npm run check:tests`).
- Bugs: list them in `docs/known-bugs.md`; every fix starts with a failing regression test; no known bug may stay open at the end of a milestone.
- English everywhere (code, comments, docs, commit messages). TypeScript strict, ESM, no `any`, TSDoc on public APIs, units in names (`Meters`, `Deg`, `Rad`, `Px`, `Ms`).
- Hot paths: performance-critical modules are named `*.hot.ts` and open with a TSDoc header `@hotpath <reason>` and `@benchmark <path>`; they are exempt from the function and module length limits (`npm run check`).
- `core` has no runtime dependencies and no DOM; nothing may touch `window`, `document` or the GPU at import time (SSR test). Frameworks only in their adapter package; the rendering library only in `renderer`.
- VibeGlobe is under PolyForm Noncommercial 1.0.0 (`LICENSE.md`); every package.json declares `PolyForm-Noncommercial-1.0.0` (`npm run check`). Third-party code: permissive licenses only (MIT, BSD, Apache-2.0, ISC; OFL fonts). Never copy code from other engines: study, then write original code.
- The project runs no servers: consumers host tiles, packages and engine assets (ADR 0015). Never commit keys (`GOOGLE_MAPS_API_KEY` comes from the environment).
- Research: read only the parts of other engines that answer the current question; keep notes short.
- Record significant decisions as ADRs (`docs/adr/README.md` has the conventions). Survey prior art first (`docs/research/`).
- Owner-only blockers go to `docs/open-questions.md` (use a stub and continue); out-of-scope ideas go to `docs/follow-ups.md`.
- Parallel tracks (`docs/parallel-tracks.md`): a second session owns `packages/tools` (M9 and the offline package builder CLI) and a third owns `packages/ui` and the GIS utilities package (M12, F404–F437); this session edits neither and reviews their pull requests instead.
- Ask the owner before force pushes, deleting branches or data, publishing packages, changing repository settings.

## Working efficiently

Owner's rules (2026-10-21, ADR 0022): most waste is extra tests, repeated runs and subagents, not the product work.

- Scope: build what `PLAN.md` and `feature_list.json` require, completely. Anything else noticed (cleanups, extra checks, refactors, nice-to-haves) goes into `docs/follow-ups.md`, not into the code.
- Tests prove the behaviors in `feature_list.json` and guard fixed bugs: roughly one focused test per stated behavior, sized like the neighboring test files. Scratch checks used while working are not committed. Testing features in the plan (fuzzing, scenarios, benchmarks) are deliverables, built once at the size their entry asks for.
- Run only the tests a change affects (`npx vitest run <files>`, `npx playwright test <specs>`); never re-run tests whose code and dependencies have not changed since they last passed. The full unit and end-to-end suites run once at the end of each milestone, and in CI.
- CI: pull requests run only the affected packages, with dependency, build and browser caches; the full matrix runs on `main` and nightly. Re-run only failed jobs, a flaky one at most once, then investigate. Keep working on the next feature while CI runs.
- Never delete or weaken a test to make it pass. Duplicate tests may be merged only if no behavior loses coverage, each merge recorded in `docs/test-changes.md`.
- Verification: no extra verification passes and no subagents to double-check own work. One review per milestone in a fresh context, reporting only correctness bugs and missing requirements, then one pass that checks only the fixes; no further rounds (ADR 0021, ADR 0022).
- Subagents only for large, genuinely independent work (reading many files, a long suite whose full output is not needed); anything doable in a handful of tool calls is done directly. At most two at a time, each on separate files or packages; they create files and never commit, and each is integrated with its affected tests run.
- Pace: the earlier a correct result, the better; avoid work that does not move a feature to passing. A problem that resists three different approaches: record the options in `docs/open-questions.md`, choose the simplest that meets `PLAN.md`, and move on. Commit and push after every completed feature.
- Simplicity (owner, 2026-10-21): choose the simplest approach that meets the requirement, commit to it, and revisit it only if new information shows it fails. Prefer a maintained, permissively licensed library over building our own (decoders, transcoders, test tooling): "no copied code" means not copying other projects' code into our source; libraries as dependencies are fine. Build no infrastructure beyond what a feature entry asks for (no reproducible-build pipelines, hash checks, custom harnesses or detectors unless the entry requires them). Visual quality checks start with the simplest check that catches the defect (screenshot comparison with tolerance, black-pixel count, frame-difference threshold); a custom detector only when those cannot catch it, tuned in Node against frames captured once and saved as fixtures, not by re-rendering after every change.
- Test loop: for a group of related features, write all their tests first, run only those in one go, fix, and re-run only the failures (`--last-failed`, a file or `-g` filter); never re-run passing specs during the loop. Development runs may use short scenario paths; full-length scenarios run once when the group is done and at the end of the milestone. Never wait idle for a run: start it in the background and work on something that does not touch the same files. When a spec times out, first reduce its cost (skip empty pixels, sample fewer frames); raise a timeout only with a recorded reason.
- At the end of each milestone, add to `progress.md`: features completed, hours spent, remaining features, estimated time to finish M15.

## Layout and gotchas

- npm workspaces: libraries in `packages/*` (`@vibeglobe/<name>`, each with its own `CLAUDE.md`), the playground in `apps/playground`, a fixture host that loads the engine lazily in `apps/lazy-host`, repository scripts in `scripts/`, benchmarks in `benchmarks/`.
- Workspace packages export a `source` condition: the playground and Vitest run on TypeScript sources without building; bundle-size and tree-shaking checks use `dist/`.
- Relative imports in libraries use `.js` extensions (NodeNext); tooling scripts import `.ts` and run directly with Node ≥ 22.18.
- TypeScript is pinned to 6.0.x (typescript-eslint and TypeDoc do not support 7.x yet); eslint-plugin-jsdoc to 63.x (64+ needs Node 22.22.2).
- A PostToolUse hook (`.claude/hooks/check-edited-file.sh`) formats, lints and type-checks every file Claude edits.
- CI (ADR 0015, ADR 0022): every push runs one fast job with every non-browser check; the sharded end-to-end suite, the isolated measurements, cross-browser runs and benchmarks run only on `main`, nightly and manual runs (`workflow_dispatch`), so run the affected end-to-end specs locally before pushing.
- The repository (`SimoneRecchia/VibeGlobe`) is public since 2026-10-21: everything pushed is published, so never commit secrets, personal data or third-party material whose license does not allow it.
- Cloud containers: Playwright uses the preinstalled Chromium via `VIBEGLOBE_CHROMIUM_PATH=/opt/pw-browsers/chromium` (`init.sh` sets it).
