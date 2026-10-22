# 0035. A faster full CI run: one build per run, Playwright's image, sixteen balanced shards

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
   `actions/setup-node`; the browsers come with the image (item 3). The fast job keeps its own incremental
   build: it runs on every push, without the browser jobs.
2. **Sixteen end-to-end shards instead of eight.** With about 30 s of setup per shard and about 60 minutes of tests
   split by file, doubling the shards costs eight more setups (about 4 runner-minutes) and roughly halves the longest
   shard. With the build, measurements, cross-browser and benchmark jobs, a run uses 20 runners at most.
3. **Every browser job runs in `mcr.microsoft.com/playwright:v1.64.1-noble`** (owner, 2026-10-22), Playwright's own
   image for the pinned Playwright version, which holds Chromium, Firefox, WebKit and their system libraries: no
   `playwright install` or `install-deps` step and no browser cache. This covers the end-to-end shards, the isolated
   measurements, the benchmarks, the cross-browser job and the visual-baseline workflow, so the baselines are
   recorded in the environment the shards compare against (ADR 0012); they are re-recorded once in it. The image runs
   as root with `HOME=/root`; Mesa's EGL for Firefox is installed only if the image lacks it, and git for the
   baseline commit likewise.
4. **Schedules** (owner): the benchmarks, recorded and not gated on SwiftShader (ADR 0012), run nightly only, not on
   pushes to `main` or manual full runs; the Firefox and WebKit job runs weekly only (simplification item 11).
5. **Balanced shards**: Playwright runs fully parallel (`fullyParallel: true`), so the sixteen shards split the suite
   by test rather than by file and a long spec no longer holds one shard far past the others (2 to 14 minutes before).
   The three specs with a shared `beforeAll` setup keep their tests together in order (`mode: 'default'`).
6. **After every merge of `main`**, a full type check (`npx tsc -b --force`) runs before the push: the incremental
   build had skipped a test file the merge broke (`packages/ui/src/ui.test.ts`), and the baseline run failed on it.

## Consequences

- A full run on a push to `main` or a manual run is the fast job, the build and the sixteen shards (plus the
  measurements on manual runs): its wall-clock time is about that of the build plus the longest shard. The time before
  and after is recorded in `progress.md`.
- A failed build fails every browser job at once, with one log to read.
- Pulling the image costs each browser job about half a minute, every time, instead of an apt install that took
  between 10 seconds and 47 minutes.
