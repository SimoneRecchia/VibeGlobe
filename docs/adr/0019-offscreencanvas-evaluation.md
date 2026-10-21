# 0019. Rendering from a worker with OffscreenCanvas: evaluated, not adopted

- Status: Accepted
- Date: 2026-10-21
- Milestone: M2 (F065; completes ADR 0011, decision 8)

## Context

ADR 0011 kept rendering on the main thread and asked M2 to measure rendering from a worker with OffscreenCanvas. Worker rendering would be adopted only if all of these held, on both backends, in Chrome, Edge, Firefox and Safari:

- p95 frame interval under synthetic main-thread load (a 30 ms task every 100 ms) improves by at least 25%;
- p95 frame interval without load is at most 5% worse;
- added input-to-frame latency is at most 4 ms at p95;
- DOM overlay misalignment is 0 px.

## Method

- **Renderer:** `createRenderer({ canvas: OffscreenCanvas, host })` runs the same three.js backend without a DOM. The base imagery is decoded with `createImageBitmap`, and frames, size and pixel ratio come from a host the caller provides.
- **Playground mode** `?experiment=offscreen&render=main|worker` (`apps/playground/src/render-experiment/`).
  - **Main mode:** the normal page with `@vibeglobe/controls`.
  - **Worker mode:** the canvas is transferred to a dedicated worker that runs `createGlobe`. The page forwards pointer and wheel events and size changes, and the worker applies the same navigation as the controls.
  - **Both modes:** the page records when the browser received each input event (`event.timeStamp`) and when each frame was submitted, with the last input it includes. A red marker quad in the scene is framed by a green DOM overlay, positioned from the frame's own projection of the marker.
- **`npm run bench:offscreen`:**
  - For each backend and mode: a 5 s warm-up, then 10 s of continuous drag through real browser input (Playwright mouse events), once without and once with the synthetic load.
  - A third 10 s drag with 15 screenshots of the page. For each one, the distance between the centroids of the red marker and the green overlay.
  - Latency is the time from an input event to the submission of the first frame that includes it. Presentation adds the same compositor delay in both modes.
- **Environment:** the only one available to the agent, the cloud container: Chromium 141 with the software GPU of GPU-less CI (SwiftShader, ADR 0012), a 480 × 360 viewport. Results: `benchmarks/results/cloud-container-swiftshader/offscreen-2026-10-21T00-28-26-450Z.json`. An earlier run on the same machine gave the same picture.

## Measurements

Chromium 141, SwiftShader, all times in ms (p95 unless noted):

| Backend | Rendering   | Frame interval | Frame interval under load | Input latency p50 / p95 | Overlay offset p50 / max |
| ------- | ----------- | -------------- | ------------------------- | ----------------------- | ------------------------ |
| WebGPU  | main thread | 107.4          | 103.6                     | 48.8 / 101.1            | 0.50 / 0.81 px           |
| WebGPU  | worker      | 104.6          | 116.9                     | 58.6 / 111.0            | 2.12 / 4.05 px           |
| WebGL2  | main thread | 63.8           | 79.5                      | 46.9 / 60.3             | 0.50 / 0.71 px           |
| WebGL2  | worker      | 95.1           | 100.1                     | 56.4 / 98.1             | 1.89 / 2.55 px           |

The main-thread overlay offset of about 0.5 px is the measurement's floor: the centroid of the rasterized marker against that of a CSS box. Overlay and frame are produced in the same task, so the true offset is 0.

Against the criteria:

| Criterion                          | WebGPU                    | WebGL2                     |
| ---------------------------------- | ------------------------- | -------------------------- |
| Under load, p95 improves by ≥ 25%  | fails: 13% worse          | fails: 26% worse           |
| Without load, p95 at most 5% worse | holds: 3% better          | fails: 49% worse           |
| Added input latency ≤ 4 ms p95     | fails: +9.9 ms (p50 +9.8) | fails: +37.8 ms (p50 +9.5) |
| Overlay misalignment 0 px          | fails: about 2 px, max 4  | fails: about 2 px, max 2.6 |

## Decision

Worker rendering is **not adopted**. The engine renders on the main thread (ADR 0011, option 5a).

- Two failures are structural, not artefacts of the software GPU, so they would hold on any hardware and in any browser:
  - **Latency:** forwarding input to a worker adds a message hop and a second frame clock.
  - **Overlay alignment:** a DOM overlay positioned from the worker's frames lags the canvas by up to a frame, because the worker's frames and the page's DOM updates reach the screen independently.
- The criteria must hold in every browser, so measuring Edge, Firefox and Safari could not reverse the decision.
- Those measurements still complete the record. The owner runs them on the reference devices with the procedure in `docs/guides/hardware-testing.md`:
  - `npm run bench:offscreen -- --hardware` with `--channel chrome` or `--channel msedge`, `--browser firefox` and `--browser webkit`.
  - Safari itself on macOS or iPadOS, following the guide.
- This last step is an owner step (`docs/open-questions.md`, pending owner steps), so F065 is `pending` until then.
- Kept:
  - The renderer's OffscreenCanvas path, which ADR 0011 requires anyway: the renderer touches no DOM in that path.
  - The playground mode and the benchmark, so the evaluation can be repeated.
- Revisit when:
  - a host application needs isolation from its own long tasks more than overlay alignment;
  - or browsers can synchronize worker frames with DOM updates.

## Consequences

- The synchronous picking and projection API (`screenToGeo`, `geoToScreen`) stays synchronous, and DOM overlays stay aligned with the canvas in every frame.
- Main-thread jank in a host application delays the globe's frames. Hosts are advised to keep long tasks off the main thread. The engine's own heavy work (decoding, parsing, meshing) runs in workers (ADR 0011).
- `createRenderer` accepts an OffscreenCanvas with a host. This is documented and covered by the experiment, though no engine path uses it by default.
