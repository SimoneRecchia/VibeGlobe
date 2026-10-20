# Progress

## Current state

- Milestone in progress: **M1 Research and foundation**: 38 of 41 entries pass (`npm run status`).
- Still failing in M1 and why:
  - `F002` (session state): passes once this progress entry and a clean tree are committed at the end of the M1 session.
  - `F027` (CI) and `F041` (M1 acceptance): both require "the latest CI run on the main branch is green". CI on `claude/happy-galileo-b07j98` has been green since run 8 (runs 3, 4 and 7 failed: a deliberate type error, a formatting slip and KB-003), but this branch has not been merged into `main`; merging needs the owner's approval.
- Next after M1: M2 Globe core, starting with `F042` (WGS84 conversions) in file order.

## Session log (newest first)

### Session 2 — 2026-10-20 (milestone 1)

Done:

- Research surveys for every M1 core area in `docs/research/` (precision, depth, levels of detail, scheduling and caching, globe-to-flat, camera control, GPU and renderer, workers, testing and benchmarks), written by parallel subagents from the projects' code at pinned commits, with linked issue-tracker failure modes, and the decisions in ADRs 0004–0012. `docs/plan/architecture.md` and `quality.md` now follow those ADRs.
- Monorepo with every package of the architecture (same layout, a `CLAUDE.md` each), Prettier, ESLint (no `any`, TSDoc on public APIs, length limits, no focused/skipped tests, a local no-commented-out-code rule), knip, repository checks (`npm run check`: layout, dependency rules, hot-path headers, build info inside `dist/`), feature-list integrity and test guards, SSR import test, coverage minima, bundle-size budgets, tree-shaking check, consumer check, license audit and generated notices, benchmark harness, TypeDoc site, Claude Code PostToolUse hook, GitHub Actions CI. `npm run verify` runs every non-browser check.
- `FrameStats` (core) and a lazily loaded debug overlay (ui) driven by a playground frame loop; e2e tests for the playground and the docs site.
- Bugs found and fixed regression-first: KB-001 (the commented-out-code rule never reported), KB-002 (a deleted `dist/` was not rebuilt), KB-003 (the feature-list guard crashed on a base without the list, seen on the first pull request), KB-004 (unused exports of script modules went unreported), KB-005 (focused or skipped Playwright tests passed lint), KB-006 (the playground frame loop leaked performance entries).
- Three fresh-context milestone reviews; every gap they found is addressed. The second and third passes added: lint and Playwright config holes (`e2e/*.test.ts`, nested `skipIf`, context-provided `skip`: KB-008), the test guard's blind spot for chained test forms (KB-007), late-frame counting and gates defined once in ADR 0014 (budget tightened to 17.2 ms), `npm run verify` now also builds the playground and the docs like CI, and feature ids in ADRs 0005–0013 and six surveys corrected from the draft numbering to the final one. The first pass found: the KB-005 and KB-006 bugs; the benchmark harness now follows ADR 0012 (warm-up, 5 fresh-page runs, 2 s discarded, median of per-run p95, p50/p95/p99/max and frames over 16.7/33.3 ms, schema-versioned results with device, GPU, pixel ratio and resolution under `benchmarks/results/<device>/`, a recorded CI job); Playwright retries once on CI with `failOnFlakyTests`; ADR conventions require before-and-after measurements; stale docs fixed; ADR 0013 reconciles the conflicting ADR points (infinite far plane with CPU culling, caps on the flat map, per-tile terrain buffers, public renderer events, tile root ids, ADR 0012 probes moved to M2, the 18 ms frame-time budget).

Verified: every check was broken on purpose in a local scratch branch and failed as required (results in the commit history of this session); CI run 3 failed on a deliberate type error; the revert's own run failed on `format:check` (a table in `docs/plan/quality.md` committed unformatted in the same push), and CI was green again from the next push; `./init.sh` from a fresh clone exits 0; every command listed in the `CLAUDE.md` files works; a jscpd scan found no code shared between this repository and CesiumJS, MapLibre GL JS, deck.gl, iTowns, OpenGlobus, 3DTilesRendererJS, three.js and OpenLayers (1,844 duplicates found inside those projects, none across).

Features now passing: F001, F003–F026, F028–F040.

Decisions to note: three.js is the rendering base, pinned to exactly `three@0.186.1` (ADR 0010; r187 required before M4). The initial-JavaScript budget needs the owner's review in M2 (open question 12).

Notes for the next session:

- The owner questions in `docs/open-questions.md` (8–11) came out of the surveys; the defaults used meanwhile are listed there.
- ADR 0011 adds a `@vibeglobe/worker` package in M3; add it to `LIBRARY_PACKAGES` in `scripts/checks/structure.ts` then.
- ADR 0012 lists engine test hooks (frame read-back, injectable clock, ready/idle events) to build in M2–M3.

### Session 1 — 2026-10-20

Done:

- Read `PLAN.md`; wrote the technical plan in `docs/plan/` (architecture, API sketches, milestone task breakdown, targets, budgets and testing strategy).
- Turned every requirement into `feature_list.json` (541 entries across the 15 milestones, all `failing`). Drafted in parallel per milestone group (536 entries), merged in milestone order, then checked by two fresh-context reviewers and fixed before the first commit:
  - Coverage review added 11 entries (private repository, test-weakening guard, function and module size limits, deviations recorded in ADRs, compression / data-pipeline / data-layer surveys, layer plug-ins, cache-store and network-policy plug-ins, terrain and vector tiles in packages) and strengthened weak ones (no open known bug in every acceptance entry, both offline setups in the switch matrix, touch pan, explicit cancellation, glTF conformance).
  - Fidelity review fixed entries that required capabilities from later milestones (moved, or limited to what exists then), contradictions (three.js no longer mandatory; OpenStreetMap profile limits only what its terms forbid; phones best effort; owner approval before publishing) and unprovable steps (numeric thresholds).
  - Removed as duplicates or overreach: a second custom-elevation-encoding entry, a second tree-shaking entry, the in-browser package builder, the optional fresher Sentinel-2 mosaic and OpenStreetMap raster tiles (the last three moved to `docs/follow-ups.md`).
- Created `init.sh`, `npm run status` (`scripts/status.ts`), `CLAUDE.md`, `README.md`, ADRs 0001–0003, the research-survey index, `docs/open-questions.md` and `docs/follow-ups.md`.
- Minimal monorepo so `init.sh` works end to end: TypeScript 6.0.3 project references, Vite 8, Vitest 5, Playwright 1.64 (drives the container's preinstalled Chromium through `VGE_CHROMIUM_PATH`).

Verified: `./init.sh` from scratch (install, build, playground up, 2 unit tests and 1 e2e smoke test green, status printed); re-run reuses the running playground; `kill $(cat .playground.pid)` stops it; `npm run status` rejects invalid statuses and duplicate ids.

Notes for the next session:

- The playground smoke test caught a favicon 404 (fixed with an inline empty icon): keep the "no console errors" assertion.
- Owner questions are in `docs/open-questions.md` (registry scope, reference devices, dataset hosting, Sentinel-2 egress, Google API key, CI capacity, license).
