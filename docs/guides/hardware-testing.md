# Testing on real hardware

CI has no GPU: it renders both backends through SwiftShader (ADR 0012). Real GPUs are checked with this procedure on the reference devices (`docs/plan/quality.md`; device details are open question 2). It covers the WebGPU and WebGL2 end-to-end tests, the scenario benchmarks with their budgets, and the OffscreenCanvas measurement (ADR 0019).

## Before the first run

1. Install Node.js 22.18 or later and Git, clone the repository and run `npm ci`.
2. Install the browsers Playwright drives: `npx playwright install chromium` (add `firefox` and `webkit` to measure those engines). For Chrome or Edge, install the browser itself.
3. Update the GPU driver. WebGPU needs Direct3D 12 on Windows, Metal on macOS and Vulkan on Linux.
4. Choose a device name in lowercase with dashes that says what the machine is, for example `desktop-rtx4070-win11` or `macbook-m3-macos15`. Results are filed under it.
5. Close other applications and connect laptops to power. Benchmarks measure the whole machine.

## Run

```sh
npm run test:hardware -- --device desktop-rtx4070-win11 --browsers chromium,msedge,firefox,webkit
```

`--browsers` lists the browsers for the OffscreenCanvas measurement: `chromium` (Playwright's build), `chrome` and `msedge` (the installed browsers), `firefox` and `webkit` (Playwright's engines; WebKit stands in for Safari, which Playwright cannot drive). The default is `chromium`.

The command sets `VIBEGLOBE_HARDWARE_GPU=1`, so every browser uses the machine's GPU instead of SwiftShader, then runs:

1. `npm run build`.
2. The visual, globe-core, precision and GPU-probe end-to-end suites on WebGPU and on forced WebGL2. Comparisons between the two backends are strict. Comparisons with the CI baselines are advisory here (recorded, not failed), because the baselines come from CI's software GPU. The GPU probes of ADR 0004 and 0005 print their results (precision, reassociation canary, depth reconstruction) into the step's log; a failure there is a precision finding for that GPU, to report against ADR 0004 or 0005.
3. `npm run bench`: the scenario benchmarks with the frame-time budgets of `quality/budgets.json`, which are binding on real GPUs. The `drag-200/400/800-<backend>` scenarios decide ADR 0010's batching rule 7: on the reference desktop, a WebGL2 CPU p95 above 3 ms in `drag-200-webgl2` or `drag-400-webgl2` switches imagery to texture pages; record the decision in ADR 0010. The run also measures 10 cold starts and checks their p90 against the 1 s target.
4. `npm run bench:offscreen` once per browser: main-thread against worker rendering (ADR 0019).

It takes 10 to 20 minutes and prints where each step's log went.

## Results

Everything goes to `benchmarks/results/<device>/`:

- `hardware-<date>/summary.json`: the device name, operating system, CPU, memory, GPU, browsers, commit and the outcome of each step.
- `hardware-<date>/e2e.json` and the per-step logs.
- `<date>.json`: the scenario benchmarks, with the browser, GPU, pixel ratio and resolution.
- `offscreen-<date>.json`: the OffscreenCanvas measurement per browser.

Commit the directory (results under `local/` are ignored, so always pass `--device`), or send it to the agent. A failing step makes the command exit with an error. The summary says which step failed.

## Checking the procedure without a GPU

`npm run test:hardware -- --device <name> --software` runs the same steps on SwiftShader, with the benchmark budgets reported rather than enforced. It checks the procedure itself on a GPU-less machine; its timings say nothing about real hardware.
