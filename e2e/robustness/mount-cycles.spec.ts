// Mount and unmount cycles (F499) and rapid mount and unmount with destruction during start-up and loading (F517):
// scenarios in `support/mount-cycles.ts`. F517 on WebGPU retains engines in CI's faster start-ups (TG-06): that run is
// `known-bugs/rapid-mount-webgpu.bug.ts`, outside the default run until fixed.
import { mountCycleTest, rapidMountTest } from './support/mount-cycles.ts';

mountCycleTest('webgl2');
mountCycleTest('webgpu');
rapidMountTest('webgl2');
