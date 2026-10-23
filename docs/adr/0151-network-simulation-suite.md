# 0151. Network simulation suite: links as fault rules plus browser interception, frames checked in the page

- Status: Accepted (decided by agent; owner may revisit)
- Date: 2026-10-23
- Milestone: M8

## Context

F315 asks for the navigation scenarios on fully offline, 400 kbps, flaky (20 % of requests dropped or reset), 500 ms
latency and LAN-only links, with zero black pixels once the base has loaded, no popping, frame times within budget,
bounded retries with backoff, all in CI. F329's acceptance adds connectivity dropping and returning, both offline
setups (packages on a LAN server, packages in browser storage) and the network-mode by loading-switch matrix, with
frames recorded on WebGPU and forced WebGL2. The fixture server already simulates latency and a shared link
(`linkBytesPerS`, F300); Playwright can intercept, abort and reset each request and take the whole context offline.
Prior art: `docs/research/testing-and-benchmarks.md` (frame-stepped scenarios, ADR 0012) and
`docs/research/offline-and-network.md`.

## Options considered

1. **Everything in Playwright routes** (delay and throttle in the route handler, as the first version of
   `e2e/offline-network-suite.spec.ts`): simple, but a route that sleeps per response is not a shared link — responses
   do not compete for the bandwidth, and a cancelled request still costs nothing on it.
2. **Everything in the fixture server**: realistic bandwidth and latency, but a reset connection and a machine with no
   network at all (which the engine's connectivity detection must notice) are browser-side events.
3. **Both, each for what it does well**: a link is the session's fault rules on the server (latency, the shared
   link's bandwidth) plus the browser-side fate of each request (continue, reset, disconnected); dropping and returning
   uses `context.setOffline`. Defined once in `scripts/fixtures/network/links.ts`, with the retry analysis, tested in
   Node.

For the frame checks: screenshots from the test (as the earlier specs) sample a few frames in real time, so a pop
between samples goes unseen; the playground's scenario harness checks every frame in the page but lives in the
playground's project. The suite records with its own small in-page recorder on the engine's manual clock
(`e2e/network/support/frames-page.ts`), with the same thresholds: holes and black pixels inside the globe in every
frame, pops (a change faster than a 250 ms fade) in frames whose camera held still.

## Decision

Option 3, with the in-page recorder. The specs live in `e2e/network/` and run in CI's sharded end-to-end job with the
other specs.

## Consequences

- Every scenario is deterministic: a fixed reset pattern, a stepped clock, fixture tiles only.
- Frame times within budget need the reference hardware (open question 2): on the container's software GPU the suite
  checks holes, black pixels, pops and retries; the frame-time step stays in `docs/hardening-backlog.md`.
- A new fault kind in the server is a hook request to the main session (`docs/parallel-tracks.md`).
