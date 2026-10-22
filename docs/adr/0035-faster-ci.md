# 0035. A faster full CI run: one build per run, sixteen shards, the cross-browser job in Playwright's image

- Status: Accepted
- Date: 2026-10-22
- Milestone: M5 (owner's request, free options only)

## Context

The full CI run (pushes to `main`, the nightly schedule, manual runs) took 54 minutes of wall-clock time in the last
complete manual run measured (39831959616, 2026-10-22). Its jobs, measured from their steps:

- Firefox and WebKit: `npx playwright install --with-deps firefox webkit` took 47 minutes (the runner's apt mirror
  was slow; the browser cache missed), then 7 minutes of tests. This job was the critical path.
- Benchmarks: 35 minutes of `npm run bench`.
- The eight end-to-end shards: about 30 s of setup each (`npm ci` 5–9 s, the cached browsers' `install-deps` 10–20 s,
  the incremental build 4–7 s), then 2 to 14 minutes of tests, about 60 minutes in all and unevenly split. Two shards
  also lost 10 and 12 minutes in `install-deps` to the same slow apt mirror.

The Free plan allows 20 concurrent jobs; only free options are wanted.

## Decision

1. **One build per run.** A `build` job runs `npm run build` once and uploads `packages/*/dist` and `apps/*/dist` as
   the `build-output` artifact (kept one day). The end-to-end shards, the isolated measurements, the cross-browser job
   and the benchmarks need it and download it instead of building; their build caches are dropped. npm stays cached by
   `actions/setup-node`, the Chromium browser by `actions/cache` (unchanged). The fast job keeps its own incremental
   build: it runs on every push, without the browser jobs.
2. **Sixteen end-to-end shards instead of eight.** With about 30 s of setup per shard and about 60 minutes of tests
   split by file, doubling the shards costs eight more setups (about 4 runner-minutes) and roughly halves the longest
   shard. With the build, measurements, cross-browser and benchmark jobs, a run uses 20 runners at most.
3. **The cross-browser job runs in `mcr.microsoft.com/playwright:v1.64.1-noble`**, Playwright's own image for the
   pinned Playwright version, which already holds Firefox, WebKit and their system libraries: no apt install of the
   browsers' dependencies on the runner. Mesa's EGL and software rasterizer are installed only if the image lacks
   them. The Chromium jobs stay on the runner itself, where the visual baselines are recorded (ADR 0012).

## Consequences

- The critical path becomes the benchmarks job (about 35 minutes) instead of the cross-browser job; the end-to-end
  suite finishes in about the time of its longest file group. The wall-clock time before and after is recorded in
  `progress.md`.
- A failed build fails every browser job at once, with one log to read.
- Chromium shards can still lose minutes to a slow apt mirror in `install-deps`; moving them into the same image would
  change the environment the baselines were recorded in, so that is left for when baselines are next re-recorded
  (`docs/follow-ups.md`).
