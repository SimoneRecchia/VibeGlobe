# 0162. Aggregate fuzz suite in Node with saved regression inputs

- Status: Accepted (decided by agent; owner may revisit)
- Date: 2026-10-24
- Milestone: M15

## Context

F513 asks for every decoder and parser (imagery, terrain, vector and 3D tiles, packages, styles, GeoJSON, KML, GPX, configuration, coordinate strings) to be fuzzed in CI with no crash, hang or uncaught error, every target listed, and failing inputs saved as regression fixtures. Per-package property tests and the browser decoder fuzzing (F114) exist but are spread out and have no common list or fixture store.

## Options considered

1. **A coverage-guided fuzzer (Jazzer.js and similar):** finds deeper bugs; a native dependency and a separate CI job, beyond what the entry asks for.
2. **fast-check properties per package:** already used in places; no shared target list, shrinking adds time, inputs are not saved as files.
3. **One Vitest suite over a target table, with byte, text and JSON-structure mutations of valid seeds (chosen):** each target declares its seeds, iterations, time limit and documented errors; it runs in the existing `scripts` test project, so CI runs it with the other unit tests.

## Decision

Option 3: `scripts/robustness/fuzz-targets.ts` lists the targets and `scripts/robustness/fuzz.test.ts` runs them. An exception the target does not document is a crash, a call past its time limit a hang; either fails the test and writes the input to `scripts/robustness/fuzz-regressions/<target>/`, which every later run replays first. The first test asserts that every required kind has a target and that every seed passes. PNG, JPEG and WebP decode only in a browser (`createImageBitmap`) and stay in `e2e/decoder-fuzz.spec.ts`; the Node imagery targets are the KTX2 reader and transcoder and world files. `VIBEGLOBE_FUZZ_RUNS` scales the iterations (2,000 is the configured count) and `VIBEGLOBE_FUZZ_SEED` replays a run.

## Consequences

The full suite runs in about 10 s. Open engine bugs it finds are listed per target (`knownBugs`, ADR 0161) and fail only with `VIBEGLOBE_FUZZ_KNOWN_BUGS=1` until fixed.
