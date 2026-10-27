// F512's renderer count: a GPU device or context loss after a camera movement keeps the lost renderer alive, one per
// loss (TG-01, docs/known-bugs.md). Outside the default run until TG-01 is fixed (docs/test-changes.md); run it with
// `npx playwright test -c e2e/robustness/known-bugs.config.ts`.
import { deviceLossTests } from '../support/device-loss.ts';

deviceLossTests('the imagery and data layers', 'imagery=world&layers=demo', true);
