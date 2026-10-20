# VibeGlobeEngine

Optimized, glitch-free web globe and map engine (TypeScript, WebGPU with WebGL2 fallback). `PLAN.md` is the owner's master brief; `docs/plan/` is the technical plan.

## Start of every session

1. Read `progress.md`, run `npm run status`, and `git log --oneline -20`.
2. Run `./init.sh` (install, build, start playground on :5173, unit + e2e tests). Fix anything broken before new work.
3. Work on the first failing feature that `npm run status` prints as "Next", and only that one.
4. Mark it `"passing"` in `feature_list.json` only after its steps pass end to end in a real browser (Playwright, screenshots for visual behavior) plus the automated tests.
5. Commit, update `progress.md`, leave the tree clean (builds, tests pass, nothing half-done).

## Commands

| Command | What |
| --- | --- |
| `./init.sh` | Install, build, start the playground (log `.playground.log`), run all tests, print status |
| `npm run build` | `tsc -b` for every package + Vite build of the playground |
| `npm test` | Vitest unit tests |
| `npm run test:e2e` | Playwright tests against the playground (starts it if needed) |
| `npm run dev` | Playground dev server at http://localhost:5173 (`PLAYGROUND_PORT` to change) |
| `npm run status` | Passing/failing counts of `feature_list.json`, per milestone, and the next feature |

## Rules that differ from defaults

- `feature_list.json`: only the `status` field ever changes. Never delete, reorder or reword entries (ADR 0003).
- Never remove or weaken a test to make it pass. Every bug fix starts with a failing regression test.
- English everywhere (code, comments, docs, commits). TypeScript strict, ESM, no `any`, units in names (`Meters`, `Deg`, `Rad`, `Px`).
- `core` has no runtime dependencies and no DOM: nothing may touch `window`, `document` or the GPU at import time (SSR-safe). three.js only inside `renderer`.
- Permissive licenses only (MIT, BSD, Apache-2.0, ISC; OFL fonts). Never copy code from other engines: study, then write original code.
- Record significant decisions as ADRs (`docs/adr/`, template `0000-template.md`). Survey prior art first (`docs/research/`).
- Owner-only blockers go to `docs/open-questions.md` (use a stub and continue); out-of-scope ideas go to `docs/follow-ups.md`.
- Ask the owner before force pushes, deleting branches or data, publishing packages, changing repository settings.

## Layout and gotchas

- npm workspaces: libraries in `packages/*` (`@vibeglobe/<name>`), apps in `apps/*`. Exact dependency versions only (`.npmrc` `save-exact`).
- Workspace packages export a `source` condition: the playground and Vitest run on TypeScript sources without building.
- Relative imports in libraries use `.js` extensions (NodeNext resolution).
- TypeScript is pinned to 6.0.x (typescript-eslint and TypeDoc do not support 7.x yet).
- Cloud containers: Playwright uses the preinstalled Chromium via `VGE_CHROMIUM_PATH=/opt/pw-browsers/chromium` (`init.sh` sets it).
