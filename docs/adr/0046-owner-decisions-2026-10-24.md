# 0046. Owner decisions of 2026-10-24: retry rounds, fog-aware detail, acceptance with hardening bugs, reference devices

- Status: Accepted
- Date: 2026-10-24 (amended 2026-10-25: decision 5)
- Milestone: M4, M5, M10, M11, M15 (F112, F148, F167, F389, F395, F403, F472, F510; KB-162)

## Context

Four questions stood between the milestones M4–M14 and the Monday 26 October target:

1. **TG-05 (F510).** After network faults stop, tiles stay on their ancestors because two rules exclude them from loading again for the rest of the session: corrupt or truncated bytes are quarantined for good (F112, `imagery-loader.test.ts` "never requests a corrupt tile again") and a tile whose retries ran out in an outage gets one more round at most (KB-162, "one more round after an outage at most"). F510 asks for full detail once the faults stop.
2. **F395 (open question 32, KB-163).** The fog-aware run of the tilted flight requests 5–13% fewer tiles, not the 25% the entry asks for: most requests are near tiles that the fog does not hide.
3. **Acceptance entries blocked by hardening bugs.** F148 (M4) waits on KB-110 (CI-only horizon pops, F137) and KB-097 (the cone ledge, F157); F167 (M5) on KB-097 and KB-170 (the terrain limit's tilt rate in a fast zoom); F389 (M10) on the draped-shape frame recordings of F364 and F365 and on KB-171 (the flaky F359 budget gate). The end-of-milestone rule allows no open known bug.
4. **Reference devices (open question 2).** Several entries time frames on a reference desktop and tablet whose details were never given.

## Decision

1. **Retry rounds after connectivity returns.** When connectivity returns (a successful health check of the source, the same signal that ends an outage), every tile that failed with a transient error (network error, timeout, 5xx, 429) or whose bytes were corrupt or truncated gets one fresh round of attempts, at most 3 such rounds per tile per session. Permanent errors (404 and other permanent statuses, no data) stay excluded. This amends F112's rule (corrupt tiles are quarantined until the next round, no longer for good) and KB-162's (up to 3 rounds instead of one); their tests are updated with the reason in `docs/test-changes.md`.
2. **F395's target.** The 25% total reduction is replaced by the behavior that matters: no fine-level request for a tile that lies entirely inside full fog, plus a measurable reduction of requests in the tilted fog scenario. F395 becomes `superseded`, replaced by F574 (`docs/feature-changes.md`).
3. **Acceptance with hardening bugs.** F148, F167 and F389 are listed in `docs/hardening-backlog.md` with their bugs, and their milestones close. KB-097, KB-110, KB-170 and KB-171 may stay open until the hardening weeks: for these bugs only, this overrides the rule that no known bug stays open at the end of a milestone. Entries blocked only by reference devices (F403, F472 and similar) stay `pending`.
4. **Reference devices.** There is no reference tablet: every tablet step stays pending until one is available. The reference desktop is the owner's Mac; its details come with the owner's hardware run (`npm run test:hardware`).
5. **Rounds given back once the source is stable (owner, 2026-10-25, open question 33, option b).** Under long flapping faults a tile could spend its 3 rounds during the faults and stay on its ancestor once they stopped (F510, about one CI run in four). A source stable again gives every tile its rounds back: 20 network successes in a row, or a success at least 30 s after its last transient network failure (`STABLE_SUCCESSES`, `STABLE_MS` in `imagery-loader.hot.ts`). Tiles out of rounds then load again. Corrupt bytes do not count against stability: a tile that is really corrupt gets its rounds back only after network faults, never in an endless cycle. A tile whose source answered other tiles during its round was not hidden by an outage: it waits for this stability, not for the next answer of decision 1 (KB-204, 2026-10-25).

## Consequences

- A tile that is really corrupt costs at most 3 extra requests per session, each after a health check succeeded, and 3 more after each network fault the source recovers from (decision 5); a tile corrupted in transit loads once the faults stop.
- Under long flapping faults, tiles out of rounds load again once the source is stable (decision 5): a stable network never leaves a tile on its ancestor.
- F395's replacement is testable on CI's software GPU, where the measured reduction is small but the fogged tiles' levels are deterministic.
- M4, M5 and M10 close with their hardening bugs recorded; the hardening weeks pick them up first.
