# VibeGlobe

Optimized, glitch-free web globe and map engine (TypeScript, WebGPU with WebGL2 fallback). `PLAN.md` is the owner's master brief; `docs/plan/` is the technical plan.

## Lightness first (owner, 2026-10-31)

The engine must run smoothly on the weakest PC there is: an old SCADA workstation with an integrated GPU and little memory. Google Earth, with far more content, is navigated on 20-year-old computers: if ours is heavier, our code is the problem. Every line, byte, allocation and frame is a cost to justify.

- **The shortest code that gives the result.** Before adding, look for what to remove; what can be said in half the lines is said in half. A change that adds lines removes more elsewhere when it can.
- **Nothing "just in case":** no options, parameters, branches, fallbacks, abstractions, events or exports nobody uses today. Dead code, duplicate helpers and one-use wrappers are deleted.
- **One source for each thing:** reuse before writing; never a second copy of a helper, constant or type.
- **Work only when something changed:** no polling, timers or frame loops while the view is still; draw only what is in view; sample, upload and allocate only for what changed; nothing per frame that can be done once.
- **Bytes:** no dependency for what a few lines do; narrow imports so tree-shaking works; what the first frame does not need loads later. Package budgets only fall.
- **Measure, do not guess:** bundle size, frame time and long tasks before and after every performance change.

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
- VibeGlobe is under the Mozilla Public License 2.0 (`LICENSE.md`, ADR 0043); every package.json declares `MPL-2.0` and every source file under `packages/*/src` opens with the MPL notice (`npm run check`). Third-party code: permissive licenses only (MIT, BSD, Apache-2.0, ISC; OFL fonts). Never copy code from other engines: study, then write original code.
- The project runs no servers: consumers host tiles, packages and engine assets (ADR 0015). Never commit keys. The library ships no adapter of a paid or proprietary provider (owner, 2026-11-01): an application connects one (Google, …) from its own code through the generic adapters and a profile of its terms.
- Research: read only the parts of other engines that answer the current question; keep notes short.
- Record significant decisions as ADRs (`docs/adr/README.md` has the conventions). Survey prior art first (`docs/research/`).
- Owner-only blockers go to `docs/open-questions.md` (use a stub and continue); out-of-scope ideas go to `docs/follow-ups.md`.
- Parallel tracks (`docs/parallel-tracks.md`): the earlier tracks are merged and their sessions closed (M6 input, M11 atmosphere and M13 computational parts merged through this branch on 2026-10-23); their waiting lists are the to-do of their milestones (M6, M7, M8, M10, M11, M13, M14): review the track's code in that milestone's review, wire the engine features it waits for, replace its stubs, and answer every open row of the "Hook requests" table. Three tracks start once `main` is updated (owner, 2026-10-23), each on its own branch with pull requests the owner merges: A) `packages/ui`, `packages/gis`, `packages/vue`, `packages/web-component`, `apps/nuxt-example` (M12, M14); B) `packages/sources` except `xyz-imagery.ts` and `fetchTransport`, and `packages/offline` (M7, M8); C) new `packages/models` and `packages/quality`. Once `main` is updated, do not edit those packages except to answer their hook requests.
- Ask the owner before force pushes, deleting branches or data, publishing packages, changing repository settings.
- Commits, pushes, pull requests and comments go out in the owner's name only (owner, 2026-10-31): git author `Simone Recchia <recchia.sim@gmail.com>`, and no AI attribution anywhere (no `Co-Authored-By` or session trailers, no "Generated with" footers), so GitHub credits the owner's account.

## Working efficiently

Owner's rules (2026-10-21, ADR 0022): most waste is extra tests, repeated runs and subagents, not the product work.

- Scope: build what `PLAN.md` and `feature_list.json` require, completely. Anything else noticed (cleanups, extra checks, refactors, nice-to-haves) goes into `docs/follow-ups.md`, not into the code.
- Tests prove the behaviors in `feature_list.json` and guard fixed bugs: roughly one focused test per stated behavior, sized like the neighboring test files. Scratch checks used while working are not committed. Testing features in the plan (fuzzing, scenarios, benchmarks) are deliverables, built once at the size their entry asks for.
- Run only the tests a change affects (`npx vitest run <files>`, `npx playwright test <specs>`); never re-run tests whose code and dependencies have not changed since they last passed. The full unit and end-to-end suites run once at the end of each milestone, and in CI.
- CI: pull requests run only the affected packages, with dependency, build and browser caches; the full matrix runs on `main` and nightly. Re-run only failed jobs, a flaky one at most once, then investigate. Keep working on the next feature while CI runs.
- Never delete or weaken a test to make it pass. Duplicate tests may be merged only if no behavior loses coverage, each merge recorded in `docs/test-changes.md`.
- Verification: no extra verification passes and no subagents to double-check own work. One review per milestone in a fresh context, reporting only correctness bugs and missing requirements, then one pass that checks only the fixes; no further rounds (ADR 0021, ADR 0022).
- Subagents only for large, genuinely independent work (reading many files, a long suite whose full output is not needed); anything doable in a handful of tool calls is done directly. At most two at a time, each on separate files or packages; they create files and never commit, and each is integrated with its affected tests run.
- Merge this branch into `main` through a pull request (merge commit) at least every 4 hours and at the end of each milestone, so parallel sessions start from current code (owner, 2026-10-23).
- After every merge of `main`, run a full type check (`npx tsc -b --force`) before pushing: the incremental build can skip files the merge broke (ADR 0035).
- Long runs in CI (owner, 2026-10-22): for full or long end-to-end runs, push and start a manual CI run (`workflow_dispatch` of `.github/workflows/ci.yml`, eight shards in parallel) instead of running them locally; keep working on other items meanwhile and react to the results when they arrive. Locally run only the few specs being changed.
- Time box (owner, 2026-10-22): every blocker gets at most 2 hours. If an item still resists then, record it (a known bug, or an open question with the options), choose the simplest way forward that meets `PLAN.md`, and move on to the next item. Decisions only the owner can make go to `docs/open-questions.md` as pending, and work continues without waiting.
- Pace: the earlier a correct result, the better; avoid work that does not move a feature to passing. A problem that resists three different approaches: record the options in `docs/open-questions.md`, choose the simplest that meets `PLAN.md`, and move on. Commit and push after every completed feature.
- Simplicity (owner, 2026-10-21): choose the simplest approach that meets the requirement, commit to it, and revisit it only if new information shows it fails. Prefer a maintained, permissively licensed library over building our own (decoders, transcoders, test tooling): "no copied code" means not copying other projects' code into our source; libraries as dependencies are fine. Build no infrastructure beyond what a feature entry asks for (no reproducible-build pipelines, hash checks, custom harnesses or detectors unless the entry requires them). Visual quality checks start with the simplest check that catches the defect (screenshot comparison with tolerance, black-pixel count, frame-difference threshold); a custom detector only when those cannot catch it, tuned in Node against frames captured once and saved as fixtures, not by re-rendering after every change.
- Test the math first: cover tile selection, morph factors, skirts and stitching, geoid conversion and height queries with fast unit tests in Node; e2e scenarios only confirm the integration.
- Before an expensive run, check the test's own setup cheaply: the fixture server really returns the 404, the marker check works on flat ground, the scene loads.
- Deterministic scenarios: drive a manual clock and step frames instead of waiting on real time, serve every tile from local fixtures, use a small canvas (for example 320x240), and sample only the frames the check needs.
- Fail fast while developing: a per-test timeout of 60 s and one log line per scenario stage, so a hang shows where it is. Long timeouts only for the full-length runs at the end.
- Debug from saved frames: when a pixel check fails, save the offending frames once and investigate them in Node instead of re-running the scenario.
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
- Vite's dev server can miss edits written by scripts and keep serving a stale module (a page that disagrees with Node tests): restart it (`npm run dev`, after removing `node_modules/.vite`) before the end-to-end runs that follow such edits.
- A spec that fails only in CI (fonts, software GPU): reproduce it in CI's image against the host's dev server, `docker run --rm --network host -v $PWD:/work -w /work mcr.microsoft.com/playwright:v1.64.1-noble npx playwright test <spec> --no-deps`.
- Cloud containers: Playwright uses the preinstalled Chromium via `VIBEGLOBE_CHROMIUM_PATH=/opt/pw-browsers/chromium` (`init.sh` sets it).
- Bundle budgets are measured again in CI's Fast checks, and CI's figures run higher than `npm run size` on a Mac: the core's main entry about 0.17 KB more (main on 2026-10-30: 64.99 KB in CI, 64.82 locally, budget 65). Keep that margin before pushing a core change; to make room, look first for code the core has twice (the constraints' bounds check was a copy of `validateBounds`).
- `max-lines` (400) counts code lines, not comments: when a `types.ts` reaches it, move a group of types to a module of its own and re-export it (`globe/constraint-types.ts`).
- `scripts/integration/europe-preset-guide.test.ts` counts the Europe preset guide's ```ts examples and type-checks them: a new example changes the count, so write short snippets as inline code or update the test with its row in `docs/test-changes.md`.
- A feature entry pushed on a branch cannot be reworded, not even before its pull request merges (`check:features` compares with the previous push and the base): to change it, start a new branch and pull request.
- The repository accepts squash merges only (the "merge commit" above is refused): `gh pr merge --squash --auto`, with the Fast checks required. `gh pr close --delete-branch` deletes the remote branch: ask first, as for any branch.
- Release tarballs: `npx tsc -b`, `npm run build:browser -w @vibeglobe/web-component`, then `npm run release:pack`, which deletes `release-0.1.0/README.md` (restore it with `git checkout -- release-0.1.0/README.md`). Packing is deterministic: an unchanged package gives the same tarball.
- On a Mac, `packages/tools/src/output/output.test.ts` and `pipeline/pmtiles-extract.test.ts` time out (on a clean `main` too); CI runs them.
- Do not edit package sources while a Playwright run is going: the playground's Vite reloads the page and the running specs fail with "Execution context was destroyed". Edits to `dist/` (a `tsc -b`) are safe, the playground runs on sources.
- On a Mac, on a clean `main` too (2026-10-30/31): `e2e/vector-tiles/layer-types.spec.ts` "matches its baseline" differs on the background view by about 130–190 pixels, and `e2e/atmosphere.spec.ts` fails its four WebGPU checks (the orbit baseline 25 % off, no haze steps, the terminator 4.2° off, WebGPU vs WebGL2 65 % apart). Compare a change's numbers with `main`'s before blaming it; the baselines come from CI's image.
- In TSL a node is emitted where it is first used: a value read in both branches of an `If`/`Else`, or after a loop, must be a `.toVar()` declared before them, or the other branch reads zero (KB-141; the night overlay hit it on 2026-10-31).
- The renderer's main entry has about 0.5 KB below its budget since the GPU probes have their own entry (see its `CLAUDE.md`); measure shader changes with `npm run size` before pushing.
