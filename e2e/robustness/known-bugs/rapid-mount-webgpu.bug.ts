// F517 on WebGPU: in CI, engines destroyed at some moment of a fast start-up stay alive, about 60 in 1000 with their
// DOM nodes and listeners (TG-06, docs/known-bugs.md). Outside the default run until TG-06 is fixed
// (docs/test-changes.md); run it with `npx playwright test -c e2e/robustness/known-bugs.config.ts`.
import { rapidMountTest } from '../support/mount-cycles.ts';

rapidMountTest('webgpu');
