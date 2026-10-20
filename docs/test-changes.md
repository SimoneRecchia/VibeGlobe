# Test changes log

Tests protect the work (`PLAN.md`, Working method): a test is never removed or weakened to make it pass. When a test is genuinely wrong, or a quality gate must change, record it here before the change lands. `npm run check:tests` fails on a deleted test, a removed test case, a lowered coverage threshold or a loosened budget or tolerance unless this log names it.

Each entry names the test file and test title (or the gate file and key path), the change and the reason.

| Date       | Test or gate                                                                                               | Change                                  | Reason                                                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-20 | benchmarks/budgets.test.ts "percentile"                                                                    | Suite renamed to "statistics"           | The suite now covers the ADR 0012 statistics (median, distributions, per-run summaries); its case "uses the nearest-rank method" is kept and extended with `median`. |
| 2026-10-20 | benchmarks/budgets.test.ts "summarizes a run with p50, p95, p99, max and the frames over 16.7 and 33.3 ms" | Expected `over16_7` changed from 3 to 2 | The old expectation counted an on-time 17 ms interval as late; frames now count as late only beyond 0.5 ms of vsync timer jitter (ADR 0013), found by the M1 review. |
| 2026-10-20 | benchmarks/budgets.test.ts "counts late frames with a tolerance for vsync timer jitter"                    | Expected `over33_3` changed from 3 to 1 | ADR 0014 defines "over 33.3 ms" as missing at least two refreshes (beyond 33.8 ms); the earlier expectation counted single dropped frames.                           |
