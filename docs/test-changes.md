# Test changes log

Tests protect the work (`PLAN.md`, Working method): a test is never removed or weakened to make it pass. When a test is genuinely wrong, or a quality gate must change, record it here before the change lands. `npm run check:tests` fails on a deleted test, a removed test case, a lowered coverage threshold or a loosened budget or tolerance unless this log names it.

Each entry names the test file and test title (or the gate file and key path), the change and the reason.

| Date       | Test or gate                            | Change                        | Reason                                                                                                                                                               |
| ---------- | --------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-20 | benchmarks/budgets.test.ts "percentile" | Suite renamed to "statistics" | The suite now covers the ADR 0012 statistics (median, distributions, per-run summaries); its case "uses the nearest-rank method" is kept and extended with `median`. |
