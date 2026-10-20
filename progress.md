# Progress

## Current state

- Milestone in progress: **M1 Research and foundation** (nothing passing yet).
- Feature list: 541 entries, all failing (`npm run status`).
- Working skeleton: npm workspaces, `@vibeglobe/core` (WGS84 constants + tests), `apps/playground` (Vite), Vitest, Playwright smoke test, `init.sh`, `npm run status`.
- Next: `F001` and the rest of M1 in file order. Session 1 already wrote the technical plan (F001) and the session-state files (F002); the next session should verify them against their steps, mark them passing if they hold, then continue with the M1 research surveys (good candidates for parallel subagents, one area each).

## Session log (newest first)

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
