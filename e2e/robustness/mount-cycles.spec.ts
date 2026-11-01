// Mount and unmount cycles (F499) and rapid mount and unmount with destruction during start-up and loading (F517):
// scenarios in `support/mount-cycles.ts`.
import { mountCycleTest, rapidMountTest } from './support/mount-cycles.ts';

mountCycleTest('webgl2');
mountCycleTest('webgpu');
rapidMountTest('webgl2');
rapidMountTest('webgpu');
