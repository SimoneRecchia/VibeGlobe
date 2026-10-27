// GPU device loss (WebGPU) and WebGL context loss injected at random moments of navigation (F512), with imagery and
// data layers: the scenario is in `support/device-loss.ts`, with the check that no renderer is kept per loss (TG-01).
import { deviceLossTests } from './support/device-loss.ts';

deviceLossTests('the imagery and data layers', 'imagery=world&layers=demo', true);
