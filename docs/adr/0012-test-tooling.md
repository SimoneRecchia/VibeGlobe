# 0012. Test tooling, image tolerances and benchmark method

- Status: Accepted (partly superseded by 0013)
- Date: 2026-10-20
- Milestone: M1–M3 (benchmark harness in M1; visual regression, renderer GPU tests and property-based tests in M2; scenario capture and fuzzing in M3)

## Context

`PLAN.md` (Testing and verification, Performance and quality targets) requires visual regression of canonical views on WebGPU and WebGL2, scenario tests that record frames and detect black pixels, holes, popping, flicker and seams, benchmarks of frame-time distribution, start-up, tiles, requests and memory tracked over time, property-based tests with reproducible seeds, fuzzing of every decoder, and CI on machines without a GPU. [quality.md](../plan/quality.md) defines the budgets and defect metrics. [ADR 0002](0002-monorepo-and-tooling.md) already chose Vitest 5.0.5 and Playwright 1.64.1. This ADR decides what to add: the rasterizer and browser flags for CI, how frames are captured and compared, the tolerances, the benchmark method, and the property-testing and fuzzing libraries.

Evidence is in the survey [Rendering tests and benchmarks](../research/testing-and-benchmarks.md): how CesiumJS, MapLibre GL JS, three.js, Babylon.js, deck.gl and Filament test and benchmark rendering, 20 issues from their trackers, and probes run in this repository's container (Chromium 141, no GPU).

## Options considered

1. **Rasterizer in CI.**
   - _WebGL stub_ (CesiumJS): runs the code, verifies no pixel. Rejected: the visual targets would go untested.
   - _SwiftShader inside Chromium_ (MapLibre, deck.gl, Filament web): no installation, WebGL2 and WebGPU both available, bit-identical across launches (measured). Cons: inaccurate `sin`/`cos` (up to 981 m error on a globe in [deck.gl#10804](https://github.com/visgl/deck.gl/issues/10804)), slow (67 ms per 1280×720 frame with read-back, measured), meaningless timings.
   - _Mesa Lavapipe or llvmpipe_ (three.js, Filament desktop): system packages and driver paths that Chromium can silently bypass ([three.js#33559](https://github.com/mrdoob/three.js/issues/33559)).
   - _Cloud real GPUs_ (Babylon.js on BrowserStack): realistic, but per-device baselines, cost and an external service; owner decision (open question 6).
2. **Capture.** Page screenshots (CesiumJS, three.js, Babylon.js, deck.gl) include the compositor and DOM and are asynchronous to frames. Engine read-back (MapLibre, Filament) is exact to one engine frame and is required anyway for frame-by-frame scenario analysis.
3. **Comparator and baseline management.**
   - Playwright `toMatchSnapshot`/`toHaveScreenshot`: baseline workflow built in, but its vendored pixelmatch uses YIQ while current pixelmatch uses OKLab HyAB, and it cannot compare two images produced in the same run (needed for WebGPU against WebGL2).
   - `pixelmatch` 8.0.0 (ISC) with `pngjs` 7.0.0 (MIT): used by MapLibre and deck.gl; anti-aliasing detection removed all 155 edge differences between the backends in the probe; pure JavaScript, runs in Node and in the page.
   - `odiff-bin` 4.5.0 (MIT, native binary, fastest), `looks-same` 10.0.1 (MIT, CIEDE2000), `ssim.js` 3.5.0 (MIT): no need at our image counts, extra binaries or a structural metric that can hide a small hole. `sharp` is excluded (its prebuilt libvips binaries are LGPL). `resemblejs` needs the native `canvas` package.
4. **Baseline policy.** Several accepted baselines per test (MapLibre: 141 tests, names such as `expected-win-flaky.png`) erode the check; local-only baselines (CesiumJS) give CI no signal; per-backend baselines generated in one pinned environment (Filament, Babylon.js) are reproducible.
5. **Property-based testing.** `fast-check` 4.10.2 (MIT, maintained, shrinking, seed and replay path printed on failure, model-based `fc.commands`, Vitest integration through `@fast-check/vitest` 0.5.0, MIT, peer `vitest ^4.1.0 || ^5.0.0`). `jsverify` 0.8.4 (MIT) and `testcheck` 1.0.0-rc.2 (BSD-3-Clause) are unmaintained.
6. **Fuzzing.** fast-check arbitraries over random and mutated fixture bytes, with `@fast-check/worker` 0.6.0 (MIT) to kill hanging predicates; `@jazzer.js/core` 4.0.0 (Apache-2.0, coverage-guided through libFuzzer, native addon, Jest-oriented); `jsfuzz` (Apache-2.0, abandoned 2022).
7. **Benchmarks.** Micro: Vitest 5's `bench` fixture on tinybench 6.2.2 (MIT, already installed; `bench.compare`, `writeResult` for A/B) against `mitata` 1.0.34 (MIT, a new dependency) and Benchmark.js (unmaintained). Frame time: timing budgets gated in CI (noisy and meaningless on SwiftShader, [maplibre-gl-js#4858](https://github.com/maplibre/maplibre-gl-js/issues/4858)) against absolute budgets on hardware plus interleaved A/B regression tests (Babylon.js method) and deterministic counters gated in CI.
8. **Renderer tests needing a GPU device.** Only through playground pages in Playwright, or co-located browser tests with Vitest browser mode (`@vitest/browser-playwright` 5.0.5, MIT, peer `vitest 5.0.5`), as deck.gl does.

## Decision

**Tools and packages** (development dependencies only, exact versions):

| Purpose                                                         | Package                                                      | Version       | License    |
| --------------------------------------------------------------- | ------------------------------------------------------------ | ------------- | ---------- |
| Unit, integration, property, fuzz and micro-benchmark runner    | `vitest` (already installed; `bench` fixture uses tinybench) | 5.0.5         | MIT        |
| Visual, scenario, chaos and performance tests on the playground | `@playwright/test` (already installed)                       | 1.64.1        | Apache-2.0 |
| Renderer tests on a real GPU device (M2)                        | `@vitest/browser-playwright`                                 | 5.0.5         | MIT        |
| Image comparison                                                | `pixelmatch`                                                 | 8.0.0         | ISC        |
| PNG encode and decode of read-backs and baselines               | `pngjs`, `@types/pngjs`                                      | 7.0.0, 6.0.5  | MIT, MIT   |
| Property-based tests                                            | `fast-check`, `@fast-check/vitest`                           | 4.10.2, 0.5.0 | MIT, MIT   |
| Fuzzing with hang detection (M3)                                | `@fast-check/worker`                                         | 0.6.0         | MIT        |

**Browsers and flags.** Playwright projects:

- `ci-webgl2` and `ci-webgpu` (CI and any machine, headless): `channel: 'chromium'` (Chromium's new headless mode in Playwright's pinned Chrome for Testing build, 156.0.8078.4 for 1.64.1; the old headless shell is not used). WebGL2: `--use-angle=swiftshader --enable-unsafe-swiftshader`. WebGPU: the same plus `--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader --use-webgpu-adapter=swiftshader`. Both add `--disable-lcd-text --hide-scrollbars --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --deterministic-mode`. Viewport 960×540 at device pixel ratio 1 (set through Playwright's `deviceScaleFactor`), plus a `ci-webgl2-hidpi` subset at ratio 2.
- `hw-webgpu` and `hw-webgl2` (local hardware, headed, opt-in with `VGE_HW=1`): no SwiftShader flags and no blocklist override; `--enable-webgpu-developer-features` (unquantized timestamp queries) and `--enable-precise-memory-info`; on Linux also `--enable-unsafe-webgpu --enable-features=Vulkan`.
- Startup assertions in every visual, scenario and benchmark test: on CI projects the browser version equals the pinned one, the WebGL2 `UNMASKED_RENDERER_WEBGL` contains "SwiftShader", and the WebGPU adapter is `google`/`swiftshader`; on every project the engine's active backend equals the project's backend. A mismatch fails the test; it is never a skip ([three.js#33559](https://github.com/mrdoob/three.js/issues/33559)). Runs on another browser build (the cloud container ships Chromium 141) are advisory and cannot update baselines.

**Capture.** Tests read pixels from the engine through a test hook, never from page screenshots (page screenshots remain for DOM controls in M12): WebGL2 reads right after the frame's draw; WebGPU copies the canvas texture (configured with `COPY_SRC` in test mode) to a buffer, handling 256-byte rows and BGRA. Images are PNG, never JPEG.

**Comparison helper.** One helper in the end-to-end test support code compares an RGBA read-back with a baseline at `testInfo.snapshotPath()` using pixelmatch 8 with anti-aliasing detection on, writes the baseline when Playwright runs with `--update-snapshots`, and attaches expected, actual and diff PNGs to the report (uploaded as CI artifacts on failure). Baselines live under a per-project `snapshotPathTemplate` (`{projectName}`), are generated only in the pinned CI environment (a manually triggered workflow or Playwright's 1.64.1 Docker image), and change only in a commit that says why. One baseline per view and backend; no alternative baselines.

**Tolerances** (pixelmatch 8 threshold, then the share of differing pixels):

| Comparison                                               | Threshold                        | Max differing pixels                               | Basis                                                                                |
| -------------------------------------------------------- | -------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Same backend, same rasterizer, against its baseline (CI) | 0.05                             | 0.01% (51 px at 960×540)                           | SwiftShader measured bit-identical across launches; stricter than MapLibre's 0.025%  |
| WebGPU against WebGL2, same run, same machine            | 0.1                              | 0.1%                                               | Measured 0.067% raw edge differences, 0 after anti-aliasing detection; Filament 0.1% |
| Real GPU against the CI baseline (hardware projects)     | 0.1, plus a 1 px shift allowance | 0.2% (initial; calibrated in M2, never above 0.5%) | Filament's device shift tolerance; Babylon.js and deck.gl allow 1% across GPUs       |

A per-view override needs a linked issue and a reason in the test, and never exceeds ten times the default. Independently of baselines, scenario detectors are zero-tolerance invariants on every captured frame, using fixture imagery that never contains the sentinel clear color (pure magenta): zero sentinel pixels after the base loads; while the camera is static, every changed pixel lies in a tile the engine reports as fading and changes no faster than the fade allows; no pixel oscillates across consecutive frames under sub-pixel camera moves (flicker, z-fighting); no background line along projected tile boundaries. Known-position probes compare rendered markers with CPU float64 projections (≤ 0.5 px) on both backends, because a SwiftShader golden can encode math errors ([deck.gl#10804](https://github.com/visgl/deck.gl/issues/10804)). Scenario tests assert these invariants, not golden images, so the arrival order of tiles may vary.

**Determinism.** The engine accepts an injectable clock and a manual step in test mode (animation time advances a fixed 1/60 s per captured frame), fades and animations run on that clock, seeds are explicit, and captures wait for the engine's `ready` and `idle` signals, never for a fixed delay or network idle ([cesium#12281](https://github.com/CesiumGS/cesium/issues/12281)). Each test file creates and destroys its own engine instance.

**Flakiness.** CI runs Playwright with `retries: 1` and `failOnFlakyTests: true`: the retry records a trace, but a test that passes only on retry fails the run. Device loss, a crashed page or a timeout is a failure, never a restart that counts as a pass.

**Benchmark method.**

- Micro-benchmarks: `*.bench.ts` next to hot-path code with Vitest's `bench` fixture; `bench.compare` and `writeResult` files for before/after evidence in ADRs; referenced from `*.hot.ts` headers; not gated in CI.
- Scenario benchmarks (budgets): on hardware projects, headed, display at native refresh, machine on mains power. One warm-up run discarded, then 5 runs in fresh pages; in each run the first 2 s are discarded. Per frame: rAF interval, main-thread CPU work (the `vge:frame` measure), GPU time (WebGPU `timestamp-query`; WebGL2 `EXT_disjoint_timer_query_webgl2` where exposed, otherwise recorded as unavailable), upload time and bytes, tiles, requests. Per run: p50, p95, p99, max, frames over 16.7 ms and 33.3 ms. A budget in `quality/budgets.json` is checked against the median of the per-run p95 values; a breach fails the command. Start-up: navigation start to the engine's `ready`, 10 cold runs with the cache disabled; the p90 must meet the 1 s target.
- Memory: JS heap through the Chrome DevTools Protocol after a forced collection; steady-state allocations through `HeapProfiler` sampling and garbage-collection trace events over 10 s of motion (must be zero); GPU memory from the engine's residency accounting.
- Regression between commits: interleaved A/B on one machine (Babylon.js): baseline and candidate builds alternate for 10 rounds with alternating order after one warm-up round; compare CPU and GPU work time per frame, not vsync-quantized intervals; drop each side's highest and lowest round; a regression is a one-sided paired t-test on log times with p < 0.05 and a median ratio above 1.05; a coefficient of variation above 10% is reported as inconclusive and re-run, never counted as a pass for a release.
- CI (SwiftShader): runs the same scenarios and stores all values as a trend, but gates only deterministic counters: zero duplicate downloads, request and tile counts, zero steady-state allocations, heap growth over 100 mount and unmount cycles, GPU resource counters at zero after `destroy()`, bundle sizes.
- Results are JSON with a schema version, commit, date and device (name, OS, browser and version, GPU adapter or renderer string, pixel ratio, resolution), recorded under `benchmarks/results/<device>/` as `quality.md` states.

**Property-based tests.** `test.prop` from `@fast-check/vitest`. CI uses a seed derived from the commit hash, printed in the log; locally the seed is random unless `VGE_FC_SEED` is set; `VGE_FC_RUNS` raises the default of 200 runs per property for long runs. A failure prints the seed, the replay path and the shrunk counterexample (verified), and every counterexample becomes an explicit regression case. State machines (scheduler, cache, tile states) use `fc.commands`.

**Fuzzing.** Per decoder: random bytes and mutated fixtures (bit flips, boundary bytes, truncation, duplication, corrupted length fields, splices between fixtures) generated by fast-check; the oracle accepts a decoded result or a typed decode error only. `@fast-check/worker` runs inputs in worker threads and fails any input over a time limit (default 100 ms); heap after a forced collection at the end must stay within 5% of the start. Budgets: 2,000 inputs per decoder in CI, 200,000 in the long run before a release; crashing inputs are committed as fixtures. Decoders that depend on browser APIs (`createImageBitmap`) are fuzzed in a Playwright page with the same arbitraries.

**Plan changes.** This confirms Vitest and Playwright (ADR 0002) and settles the property-testing library that `quality.md` left to an M2 ADR. It changes `quality.md` "WebGPU tests are skipped [in CI]": WebGPU functional, visual and scenario tests run in CI on SwiftShader; WebGPU performance and the browser matrix stay on hardware.

## Consequences

- Easier: both backends are checked on every push without a GPU; failures are reproducible bit for bit in the pinned environment; one comparator gives one meaning to every tolerance; flaky tests surface as failures instead of retries.
- Harder: baseline updates require the pinned environment, and every Chromium or Playwright upgrade regenerates the baselines in a reviewed commit. SwiftShader cannot reveal vendor precision bugs ([maplibre-gl-js#7419](https://github.com/maplibre/maplibre-gl-js/issues/7419)), so the hardware procedure stays mandatory before each release. CI scenario runs are slow (about 67 ms per 720p captured frame), so CI scenarios use 960×540 and short paths; soak tests run on hardware.
- Engine requirements this creates (M2–M3): a test mode with frame read-back, an injectable clock with manual stepping, `ready` and `idle` events, per-frame statistics (CPU, GPU, uploads, tiles, requests), the active backend and adapter information, the screen regions of fading tiles, a configurable clear color, GPU resource counters, and forced device or context loss.
- Follow-up: M1 benchmark harness uses this method; M2 adds the capture helper, the CI projects and the hardware procedure (F072, F074, F075) and calibrates the hardware tolerance; M3 adds the scenario detectors and decoder fuzzing (F114, F122, F123).
- Verification: the probes listed in the survey are repeated on Playwright's pinned Chromium in M1; F072 must fail on a changed shader color and on a 1-pixel geometry shift; each scenario detector must catch its injected defect (missing tile, fade bypass, seam, z-fighting pair) and pass the clean run; a tolerance changes only through a new ADR with the measurements behind it.
