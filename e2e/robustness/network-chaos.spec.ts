// Network chaos (F510): random faults on tiles, a LAN package, vector tiles, glyphs and styles during navigation never
// blank or freeze the view or throw uncaught (scenarios in `support/network-chaos.ts`). The raster view (TG-05) and the
// vector layer with its labels (TG-04) return to full detail after the faults stop.
import { rasterChaosTests, styleFaultTests, vectorChaosTests } from './support/network-chaos.ts';

rasterChaosTests(true);
vectorChaosTests(true);
styleFaultTests();
