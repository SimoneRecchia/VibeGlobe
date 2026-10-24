// F510's recovery: after the faults stop, the raster view keeps tiles on coarser imagery (failed tiles in view are not
// requested again, and some stay decoding: TG-05) and the vector layer keeps tiles that arrived corrupted or truncated
// missing (TG-04). Outside the default run until both are fixed (docs/test-changes.md); run it with
// `npx playwright test -c e2e/robustness/known-bugs.config.ts`.
import { networkChaosTests } from '../support/network-chaos.ts';

networkChaosTests(true);
