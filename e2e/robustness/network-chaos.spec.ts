// Network chaos (F510): random faults on tiles, a LAN package, vector tiles, glyphs and styles during navigation never
// blank or freeze the view or throw uncaught (scenarios in `support/network-chaos.ts`). The view's return to full
// detail after the faults stop fails on TG-04 and TG-05: `known-bugs/network-chaos-recovery.bug.ts`.
import { networkChaosTests, styleFaultTests } from './support/network-chaos.ts';

networkChaosTests(false);
styleFaultTests();
