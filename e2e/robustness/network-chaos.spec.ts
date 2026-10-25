// Network chaos (F510): random faults on tiles, a LAN package, vector tiles, glyphs and styles during navigation never
// blank or freeze the view or throw uncaught (scenarios in `support/network-chaos.ts`). The raster view returns to full
// detail after the faults stop (TG-05); the vector layer's return still fails on TG-04:
// `known-bugs/network-chaos-recovery.bug.ts`.
import { rasterChaosTests, styleFaultTests, vectorChaosTests } from './support/network-chaos.ts';

rasterChaosTests(true);
vectorChaosTests(false);
styleFaultTests();
