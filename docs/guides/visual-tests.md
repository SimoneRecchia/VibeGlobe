---
title: Visual tests
---

# Visual tests

The visual suite (`e2e/visual.spec.ts`) renders canonical views on WebGPU and on forced WebGL2 and compares them with baselines in `e2e/__baselines__/`. It follows ADR 0012.

## What it checks

- **Against the baselines (F072, F074):** each canonical view on each backend, and the Europe view at device pixel ratios 1, 1.5 and 2 (F071). Pixelmatch threshold 0.05 with anti-aliasing detection; at most 0.01% of pixels may differ.
- **Between backends (F073):** the same view on WebGPU and WebGL2 in the same run. Threshold 0.1; at most 0.1% of pixels may differ.
- On a failure the report holds the expected, actual and diff images. CI uploads the report and `test-results/` as the `playwright-report` artifact.

## Where it runs

- **CI:** in the end-to-end job, on pushes to `main`, nightly and manual runs. It uses software rendering on GPU-less runners: SwiftShader for WebGL2 and WebGPU, in Playwright's pinned Chromium.
- **Locally:** `npm run test:e2e -- e2e/visual.spec.ts`.
  - The cross-backend checks always apply.
  - Baselines recorded with another Chromium build (`e2e/__baselines__/browser.json`) are advisory outside CI: differences are attached and the test is annotated `advisory`.

## Updating the baselines

Baselines change only in a commit that says why, and only from the pinned environment:

1. Make the intended visual change and commit it, with the reason, on your branch.
2. Run the **Visual baselines** workflow (Actions → Visual baselines → Run workflow) on that branch. It records every baseline with `--update-snapshots=all` and commits the result to the branch.
3. Review the new images in the pull request before merging.

Never update baselines from a local machine: another GPU, driver or Chromium build gives different pixels.
