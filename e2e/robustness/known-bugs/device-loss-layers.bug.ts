// F512 with data layers (`?layers=demo`, M10): every recovery keeps the lost renderer alive (TG-01, docs/known-bugs.md).
// Outside the default run until TG-01 is fixed (docs/test-changes.md); run it with
// `npx playwright test -c e2e/robustness/known-bugs.config.ts`.
import { deviceLossTests } from '../support/device-loss.ts';

deviceLossTests('the imagery and data layers', 'imagery=world&layers=demo');
