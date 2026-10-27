// F510's recovery of the vector layer: after the faults stop, it keeps tiles that arrived corrupted or truncated missing
// (TG-04). Outside the default run until it is fixed (docs/test-changes.md); run it with
// `npx playwright test -c e2e/robustness/known-bugs.config.ts`. The raster view's recovery (TG-05) runs in
// `network-chaos.spec.ts`.
import { vectorChaosTests } from '../support/network-chaos.ts';

vectorChaosTests(true);
