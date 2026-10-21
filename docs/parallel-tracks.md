# Parallel tracks

Since 2026-10-21 two Claude Code sessions work on the repository at the same time (owner's decision). Each session edits only what it owns; anything else it needs from the other track arrives as a pull request that the owning session reviews.

| Track                                     | Session                                                   | Owns                                                                                                                                                                                                                                            |
| ----------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine (M3–M8, M10–M15)                   | Main session, branch `claude/happy-galileo-b07j98`        | Every package and app except `packages/tools`; every `feature_list.json` entry not listed below                                                                                                                                                 |
| Data pipeline and offline package builder | Second session, its own branch, pull requests into `main` | `packages/tools` (the command-line tools); M9, data pipeline and default datasets (F330–F347, F551–F554); the offline package builder CLI (F304, F305, F307); the `status` of those entries in `feature_list.json` and their records in `docs/` |

Rules:

- The main session does not edit `packages/tools`. When it reaches M8 and M9 it uses and reviews the second session's pull request instead of rebuilding that work; the engine side of offline packages (reading, installing and serving packages, network modes; M8) stays with the main session.
- The second session does not edit other packages. A change it needs elsewhere (a core API, a shared script, CI) is asked of the main session or proposed in its pull request for review.
- `feature_list.json` changes only in the `status` of each session's own entries, so the two branches merge without conflicts; shared files (`progress.md`, `docs/open-questions.md`, `docs/follow-ups.md`, `docs/known-bugs.md`) take separate sections or rows per track.
