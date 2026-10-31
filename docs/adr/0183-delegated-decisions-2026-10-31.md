# 0183. Decisions of 2026-10-31 on the open questions (delegated by the owner)

- Status: Accepted
- Date: 2026-10-31
- Milestone: M7, M11, M13, M15, the Europe preset (F574, F657; KB-219, KB-230)

## Context

The owner asked the agent to answer the questions still open in `docs/open-questions.md` itself, choosing what fits
the project best, and to do what follows from each answer. Several were old: overtaken by later decisions (the license
moved to MPL-2.0 with the DCO, ADR 0043; Google's 3D Tiles cannot run from the owner's EEA account, ADR 0031) or by
fixes (KB-219). The questions the agent had already decided for the owner to revisit (18, 19, 21, 26, 27, 28) were
read again too.

## Decision

1. **13, legal review of the licensing text.** No review is needed: the project uses the standard texts only, MPL-2.0
   (`LICENSE.md`) and the Developer Certificate of Origin (`DCO.md`), and no project-written agreement remains (the CLA
   was removed, ADR 0043). External contributions are accepted with a DCO sign-off, as `CONTRIBUTING.md` already says.
2. **16, the Google Maps key.** Neither development nor CI needs it: the Google adapter is proved by its fixture
   conformance suites, and the live session entries were superseded because the owner's EEA billing account cannot use
   Photorealistic 3D Tiles (ADR 0031). Live runs stay manual, with a key from the environment when one exists.
3. **17, how a release reaches `main`.** As built: the publish job, approved by the owner in the `npm-release`
   environment, pushes the release commit and tag to `main`. A release is a deliberate act of the owner, and a pull
   request would replace the tagged commit with a squashed copy, so the next changelog could not start from the tag.
   Creating the environment and the npm token stays the owner's step of the first release (the pending entries).
4. **34, the national orthophotos.** (a) The providers' own words, quoted through web search, are enough for the eleven
   services already in the preset: each publishes an open licence that allows commercial use. (b) Services whose
   credit is unsettled (IGN BD ORTHO, PNOA, PDOK, Alto Adige 2023, Croatia, Estonia) stay out: a source joins the
   preset only with its terms and credit known (ADR 0182). (c) Every orthophoto keeps starting at level 12 with white
   tiles as no data (KB-215); a service seen answering badly in an application is removed when reported.
5. **35, ESA WorldCover from Terrascope.** It stays out. No licence covers commercial use of the WMTS, Terrascope says
   such use "may entail associated costs", and the preset takes only sources that allow commercial use and
   redistribution (ADR 0182).
6. **36, KB-219.** Closed: the cause found on 2026-10-27 (the eye's clearance measured to the terrain grid instead of
   the mesh as drawn) is fixed with its regression test, and no view has shown it since. A recording or the
   `globe.camera` state of a view where it still happens reopens it.
7. **37, F574's measure on CI.** Option (b): the fog-aware run must request fewer tiles whose center lies in full fog
   than the full-detail run, where the fog hides most of the tile. The total count is logged, not asserted: on CI's
   software GPU it follows how many tiles arrive while each frame draws, not the fog (KB-230). The entry's step named
   the total, so F574 is superseded by F657 (`docs/feature-changes.md`); the test is fixed with its reason in
   `docs/test-changes.md`.
8. **38, Italian orthophotos for levels 15–16.** No Italian orthophoto joins the library: none found passes the
   preset's criterion online, and AGEA's CC BY 4.0 imagery has no tile service. Italy keeps the package's WorldCover to
   level 11, magnified beyond. An application that builds and hosts its own AGEA tiles adds them with `addSources`,
   having read AGEA's terms itself; the blocked hosts need not be opened for the library.
9. **18, 19, 21, 26, 27 and 28, decided earlier by the agent.** Confirmed as recorded in their ADRs (0018, 0012, 0020,
   0027, 0034, 0036).

## Consequences

- `docs/open-questions.md` has no open question left; its pending owner steps (devices, keys, money, publishing) stay,
  as they need the owner's hands, not a decision.
- F657 replaces F574; F574's test now asserts the saving where the fog is, and its CI failures of about one run in two
  (KB-230) end.
- Nothing changes in the Europe preset, the release workflow or the Google adapter.
