# Targets, budgets and testing

`PLAN.md` sets the targets; this document defines the reference devices, the initial budgets and how each is measured. Budget values are starting points: they are refined with measurements (recorded in ADRs) but the zero-artifact targets are never weakened.

## Reference devices (proposed, to be confirmed by the owner)

| Role                       | Proposed device                                                                                                            | Why                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Reference desktop          | Windows 11 laptop, Intel Core i5 12th gen with Iris Xe integrated GPU, 16 GB RAM, 1920×1080 at 1×, current Chrome and Edge | A mainstream integrated GPU: if it holds 60 fps, discrete GPUs do too |
| Reference desktop (Apple)  | MacBook Air M1, 8 GB, Retina display at 2×, current Safari and Chrome                                                      | Apple GPU, high-DPI, Safari WebGPU                                    |
| Reference tablet (iPadOS)  | iPad 10th generation (A14), current Safari                                                                                 | Most common iPad class in the field                                   |
| Reference tablet (Android) | Mid-range Android tablet with a Mali or Adreno GPU (for example Samsung Galaxy Tab S9 FE), current Chrome                  | ARM GPU coverage                                                      |

Owner hardware availability is tracked in [open questions](../open-questions.md). Until then, automated measurements run in CI (software WebGL2, functional only) and on whatever hardware the session has, recorded with the device name.

## Performance targets and initial budgets

| Metric                                                   | Target or budget                                                                                                     | How it is measured                                                                 |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Frame time during pan, zoom, flights (reference desktop) | 60 fps; p95 ≤ 16.7 ms                                                                                                | Scripted scenarios in the playground, frame timestamps over the whole run          |
| Frame rate (reference tablet)                            | ≥ 30 fps, goal 60 fps                                                                                                | Same scenarios, touch-emulated and manual on device                                |
| Main-thread CPU per frame while moving                   | ≤ 6 ms p95                                                                                                           | Performance marks around the frame loop                                            |
| GPU time per frame                                       | ≤ 10 ms p95 desktop                                                                                                  | Timestamp queries where available                                                  |
| GPU uploads per frame                                    | ≤ 2 ms and ≤ 8 MB                                                                                                    | Upload-queue instrumentation                                                       |
| Steady-state allocations in the frame loop               | 0                                                                                                                    | Heap-sampling benchmark over 10 s of motion                                        |
| First complete frame from a local or offline base        | ≤ 1 s on a LAN server                                                                                                | Navigation start to the engine's `ready`                                           |
| GPU memory                                               | Configurable; default 512 MB desktop, 256 MB tablet                                                                  | Residency accounting of textures and buffers                                       |
| RAM tile cache                                           | Configurable; default 256 MB desktop, 128 MB tablet                                                                  | Cache accounting                                                                   |
| Memory across mount/unmount                              | No growth over 100 cycles (beyond measurement noise)                                                                 | Heap snapshots before and after                                                    |
| Initial JavaScript before the first frame                | ≤ 300 KB gzip (proposed; measured in M2)                                                                             | Bundle analysis of the playground minimal entry                                    |
| Bundle size per package (min + gzip, three.js excluded)  | core ≤ 60 KB, controls ≤ 15 KB, ui ≤ 25 KB, vue ≤ 5 KB, web-component ≤ 5 KB, each source adapter ≤ 8 KB tree-shaken | Size check in CI; renderer budget set in M2 once three.js tree-shaking is measured |
| Duplicate tile downloads per session                     | 0                                                                                                                    | Request log in scenario tests                                                      |

## Visual-defect metrics

| Defect                         | Detection                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Black or empty pixels          | Every recorded frame after the base loads: count pixels equal to the clear color or outside the globe/sky/atmosphere classes; must be 0    |
| Popping                        | Frame differencing in windows where the camera is static: per-pixel change above a threshold that is not explained by a running cross-fade |
| Flicker and z-fighting shimmer | Frame differencing under sub-pixel camera moves: oscillating pixels across consecutive frames                                              |
| Seams and cracks               | Edge-line detection along projected tile boundaries; background pixels inside terrain coverage                                             |
| Vertex jitter                  | Sub-millimeter camera moves at 1 m altitude: screen-space variance of tracked points ≤ 0.5 px                                              |
| Backend consistency            | Same canonical views on WebGPU and WebGL2 within the visual-test tolerance                                                                 |

## Testing strategy and tooling

| Layer                 | Tooling                                                                           | Scope                                                                                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                  | Vitest                                                                            | Geodesy, projections, transforms, tiling, screen-space error, scheduler, cache, policies, parsers and formatters                                                                                            |
| Property-based        | Vitest + a permissively licensed property-testing library (chosen by ADR in M2)   | Round trips, symmetry, continuity at poles and the antimeridian                                                                                                                                             |
| Fuzzing               | Property-based generators plus malformed-fixture corpora                          | Every decoder and parser: tiles, packages, configuration, coordinate strings                                                                                                                                |
| Integration           | Vitest with fixture tile servers                                                  | Every source adapter (conformance suites), offline packages, connectivity changes                                                                                                                           |
| End to end and visual | Playwright driving the playground                                                 | Interactions, canonical-view screenshots on both backends, scenario recordings                                                                                                                              |
| Network simulation    | Playwright routing and throttling                                                 | Offline, slow, flaky, high-latency, LAN-only                                                                                                                                                                |
| Performance           | Playwright-driven scenario benchmarks; micro-benchmarks for hot paths             | Frame-time distribution, time to first frame, tiles, requests, memory; results written to `benchmark-results/` with device and commit (`npm run bench`); reference-device results are committed per release |
| Soak and chaos        | Long randomized navigation; injected network, storage-quota and GPU-loss failures | Memory growth, leaks, crashes, frame time                                                                                                                                                                   |
| Framework adapters    | Nuxt example app built with SSR                                                   | Server render, client hydration, every feature on the client                                                                                                                                                |

Execution environments:

- **CI (no GPU):** type check, lint, unit and integration tests with coverage thresholds, license audit, API docs build, and end-to-end and visual tests on WebGL2 through software rendering in Chromium. WebGPU tests are skipped there, with a visible note.
- **Local hardware:** WebGPU tests, performance benchmarks and the browser and device matrix, following the documented procedure (written in M2), with results recorded per release.
- **Browser matrix:** Chrome, Edge, Firefox and Safari, current and previous major versions, each on the WebGPU path where available and on the forced WebGL2 path.

Rules (from `PLAN.md`): every bug fix starts with a failing regression test; tests are never removed or weakened to pass; a genuinely wrong test is fixed with the reason recorded; coverage of core logic stays at or above 90% lines; a release ships with no open known bugs.
