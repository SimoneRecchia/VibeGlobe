// GPU device loss (WebGPU) and WebGL context loss injected at random moments of navigation (F512), with imagery and
// data layers: the scenario is in `support/device-loss.ts`. A loss after the camera moved keeps the lost renderer
// alive (TG-01): that check runs in `known-bugs/device-loss-renderers.bug.ts`, outside the default run until fixed.
import { deviceLossTests } from './support/device-loss.ts';

deviceLossTests('the imagery and data layers', 'imagery=world&layers=demo', false);
