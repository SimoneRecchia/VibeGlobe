// Pops: pixels that change in one drawn frame faster than a fade allows (F105, F563), counted by the scenario harness.
import type { FrameCapture } from '@vibeglobe/core';
import type { ScenarioReport } from './scenario-harness.js';

/** Per channel, the most a pixel may change in one drawn frame: a 250 ms fade at 60 Hz, plus rounding (plan §4.2). */
const FADE_STEP = 255 / 15;
const POP_SLACK = 4;

/** Pixels that changed in one frame faster than a fade allows; `first` receives the byte offset of the first. */
export function countPops(
  previous: Pick<FrameCapture, 'rgba'>,
  capture: Pick<FrameCapture, 'rgba'>,
  first?: (offset: number) => void,
): number {
  const limit = FADE_STEP + POP_SLACK;
  let pops = 0;
  for (let i = 0; i < capture.rgba.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      if (Math.abs((capture.rgba[i + c] ?? 0) - (previous.rgba[i + c] ?? 0)) > limit) {
        if (pops === 0) first?.(i);
        pops++;
        break;
      }
    }
  }
  return pops;
}

/** Counts a still frame's pops into the report, with the first popped pixel and its colors before and after. */
export function checkPops(report: ScenarioReport, frame: number, previous: FrameCapture, capture: FrameCapture): void {
  const pops = countPops(previous, capture, (i) => {
    if (report.firstPop) return;
    const pixel = i / 4;
    report.firstPop = {
      xPx: pixel % capture.widthPx,
      yPx: Math.floor(pixel / capture.widthPx),
      before: [...previous.rgba.subarray(i, i + 4)],
      after: [...capture.rgba.subarray(i, i + 4)],
    };
  });
  report.pops += pops;
  if (pops > 0 && report.firstPopFrame < 0) report.firstPopFrame = frame;
}
