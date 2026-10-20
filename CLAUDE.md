# VibeGlobeEngine

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

- `feature_list.json`: only the `status` field ever changes. Never delete, reorder or reword entries (ADR 0003; `npm run check:features`).
- Never remove, skip or weaken a test, and never loosen `quality/*.json`. A genuinely wrong test or gate is fixed with the reason logged in `docs/test-changes.md` (`npm run check:tests`).
- Bugs: list them in `docs/known-bugs.md`; every fix starts with a failing regression test; no known bug may stay open at the end of a milestone.
- English everywhere (code, comments, docs, commit messages). TypeScript strict, ESM, no `any`, TSDoc on public APIs, units in names (`Meters`, `Deg`, `Rad`, `Px`, `Ms`).
- Hot paths: performance-critical modules are named `*.hot.ts` and open with a TSDoc header `@hotpath <reason>` and `@benchmark <path>`; they are exempt from the function and module length limits (`npm run check`).
- `core` has no runtime dependencies and no DOM; nothing may touch `window`, `document` or the GPU at import time (SSR test). Frameworks only in their adapter package; the rendering library only in `renderer`.
- Permissive licenses only (MIT, BSD, Apache-2.0, ISC; OFL fonts). Never copy code from other engines: study, then write original code.
- Record significant decisions as ADRs (`docs/adr/README.md` has the conventions). Survey prior art first (`docs/research/`).
- Owner-only blockers go to `docs/open-questions.md` (use a stub and continue); out-of-scope ideas go to `docs/follow-ups.md`.
- Ask the owner before force pushes, deleting branches or data, publishing packages, changing repository settings.

## Layout and gotchas

- npm workspaces: libraries in `packages/*` (`@vibeglobe/<name>`, each with its own `CLAUDE.md`), the playground in `apps/playground`, repository scripts in `scripts/`, benchmarks in `benchmarks/`.
- Workspace packages export a `source` condition: the playground and Vitest run on TypeScript sources without building; bundle-size and tree-shaking checks use `dist/`.
- Relative imports in libraries use `.js` extensions (NodeNext); tooling scripts import `.ts` and run directly with Node ≥ 22.18.
- TypeScript is pinned to 6.0.x (typescript-eslint and TypeDoc do not support 7.x yet); eslint-plugin-jsdoc to 63.x (64+ needs Node 22.22.2).
- A PostToolUse hook (`.claude/hooks/check-edited-file.sh`) formats, lints and type-checks every file Claude edits.
- Cloud containers: Playwright uses the preinstalled Chromium via `VGE_CHROMIUM_PATH=/opt/pw-browsers/chromium` (`init.sh` sets it).
