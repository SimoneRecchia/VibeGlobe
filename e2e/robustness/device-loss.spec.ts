// GPU device loss (WebGPU) and WebGL context loss injected at random moments of navigation (F512), with imagery: the
// scenario is in `support/device-loss.ts`. With data layers too it keeps a renderer per loss (TG-01): that run is
// `known-bugs/device-loss-layers.bug.ts`, outside the default run until the bug is fixed.
import { deviceLossTests } from './support/device-loss.ts';

deviceLossTests('the imagery', 'imagery=world');
