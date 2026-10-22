# 0023. Simplification decisions

- Status: Accepted
- Date: 2026-10-21
- Milestone: M3 onward

## Context

The owner found the work over-engineered and slow and set simplicity rules (`CLAUDE.md`, "Working efficiently"). [docs/simplification.md](../simplification.md) listed 15 places where the plan or the code is more complex than its goals need. The owner decided on each.

## Decision

1. **Approved as written:** items 1 (no nightly transcoder rebuild), 2 (upstream Draco and meshopt builds as dependencies), 3 (`@mapbox/vector-tile`, `pbf`, `sql.js`), 5 (three.js `GLTFLoader` for glTF), 6 (seams checked by screenshot comparison against baselines; only the transparent-pixel count and the frame-difference threshold stay as in-page checks), 9 (benchmark results as CI artifacts, deterministic counters gated), 10 (trace export as a ring buffer of plain objects, JSON), 12 (surveys only when no maintained library covers the need), 14 (visual baselines at DPR 1; other ratios checked by canvas size and a coarse cross-check) and 15 (one hardware script; owner-device entries stay pending, never dropped).
2. **Item 4, Turf:** approved for planar geometry operations, on two conditions: measurement tools (distance, area, bearing) stay ellipsoidal as `PLAN.md` requires, and every Turf module with its transitive dependencies passes the license audit; a module that pulls in a copyleft dependency is replaced.
3. **Item 7, temporal checks:** the injected flicker and seam are dropped; one cheap self-test proves the frame-difference check fires, on two saved frames that differ, in Node, with no engine debug option.
4. **Item 8, scenario paths:** two paths, provided together they include a fast-pan burst, a rotation and a tilt change, so all five behaviors of the original entry are still exercised.
5. **Item 11, Firefox and WebKit:** the job runs weekly on a schedule (Monday) and on manual dispatch.
6. **Item 13, isolated measurements:** the measurements job, now including the leak suite, runs nightly and on manual dispatch.
7. **Feature list:** F122, F123 and F124 are superseded by F562, F563 and F564 with the revised steps ([ADR 0016](0016-superseded-feature-entries.md); `docs/feature-changes.md`).

## Consequences

- Less code of our own in M8, M10, M12 and M13; more third-party packages, each passing `npm run licenses` and listed in `THIRD_PARTY_NOTICES.md` when shipped.
- Seam regressions are caught by baselines in the pinned CI environment rather than by a custom detector; the baselines change when imagery rendering changes on purpose.
- Fewer CI jobs on each push to `main`; the leak suite and the cross-browser run report nightly and weekly.
