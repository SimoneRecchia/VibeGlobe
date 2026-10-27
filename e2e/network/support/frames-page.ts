// The network suite's frame recorder, loaded into the page (F315, F329): plays a navigation path frame by frame on the
// engine's manual clock, drawing and reading every frame through `captureFrame()`, and counts in the page, with the
// scenario harness's detectors, the pixels inside the globe without imagery (holes, black) and, in still frames, the
// pixels that changed faster than a cross-fade allows (pops), with the thresholds of the playground's scenario harness
// (plan §4.2). No frame crosses into the test.
import type { FrameCapture, Globe, ViewInit } from '@vibeglobe/core';

/**
 * One step of a path: a jump, a pan or zoom in frame-sized moves, a flight (drawn to its end, or for `frames` frames
 * with the flight left running), frames of a flight still running (`follow`), or frames with the camera still.
 */
export type PathStep =
  | { readonly jump: ViewInit }
  | { readonly move: ViewInit; readonly frames: number }
  | { readonly fly: ViewInit; readonly durationMs: number; readonly frames?: number }
  | { readonly follow: number }
  | { readonly hold: number };

/** What the recorder found: counts, and the first frame and place of each defect (-1 and undefined when none). */
export interface PathReport {
  frames: number;
  /** Frames compared for pops: the camera held still since the frame before. */
  staticFrames: number;
  /** Pixels inside the globe left transparent: the background shows through. */
  holes: number;
  /** Opaque pixels inside the globe whose brightest channel is below `darkBelow`: black. */
  dark: number;
  /** Pixels that changed in one still frame faster than a 250 ms fade allows. */
  pops: number;
  firstHoleFrame: number;
  firstDarkFrame: number;
  firstPopFrame: number;
  /** The first defect, in device pixels, with its frame and color. */
  first: { kind: string; frame: number; xPx: number; yPx: number; rgba: number[] } | undefined;
}

/** Per channel, the most a pixel may change in one drawn frame: a 250 ms fade at 60 Hz, plus rounding. */
const POP_LIMIT = 255 / 15 + 4;
/** Rows checked for holes: every second one. */
const ROW_STEP_PX = 2;
/** Distance from the globe's outline within which pixels are not checked (anti-aliasing). */
const EDGE_PX = 2;

/** Counts holes and black pixels inside the globe: pixels whose ray meets it, with their neighbors 2 px away too. */
function checkFrame(globe: Globe, capture: FrameCapture, scale: number, report: PathReport, darkBelow: number): void {
  const hits = (x: number, y: number): boolean => globe.screenToGeo({ xPx: x / scale, yPx: y / scale }) !== undefined;
  const { rgba, widthPx, heightPx } = capture;
  for (let y = EDGE_PX; y < heightPx - EDGE_PX; y += ROW_STEP_PX) {
    for (let x = EDGE_PX; x < widthPx - EDGE_PX; x++) {
      const i = (y * widthPx + x) * 4;
      const opaque = rgba[i + 3] === 255;
      const bright = Math.max(rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0);
      if (opaque && bright >= darkBelow) continue;
      const inside =
        hits(x, y) && hits(x - EDGE_PX, y) && hits(x + EDGE_PX, y) && hits(x, y - EDGE_PX) && hits(x, y + EDGE_PX);
      if (!inside) continue;
      const kind = opaque ? 'dark' : 'hole';
      if (opaque) report.dark++;
      else report.holes++;
      if (opaque && report.firstDarkFrame < 0) report.firstDarkFrame = report.frames;
      if (!opaque && report.firstHoleFrame < 0) report.firstHoleFrame = report.frames;
      report.first ??= { kind, frame: report.frames, xPx: x, yPx: y, rgba: [...rgba.subarray(i, i + 4)] };
    }
  }
}

/** Counts the pixels that changed faster than a fade allows between two still frames. */
function checkPops(previous: FrameCapture, capture: FrameCapture, report: PathReport): void {
  const { rgba, widthPx } = capture;
  let pops = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    let popped = false;
    for (let c = 0; c < 3; c++) popped ||= Math.abs((rgba[i + c] ?? 0) - (previous.rgba[i + c] ?? 0)) > POP_LIMIT;
    if (!popped) continue;
    if (pops++ === 0 && report.firstPopFrame < 0) {
      report.firstPopFrame = report.frames;
      const pixel = i / 4;
      report.first ??= {
        kind: 'pop',
        frame: report.frames,
        xPx: pixel % widthPx,
        yPx: Math.floor(pixel / widthPx),
        rgba: [...previous.rgba.subarray(i, i + 4), ...rgba.subarray(i, i + 4)],
      };
    }
  }
  report.pops += pops;
}

const KEYS = ['longitudeDeg', 'latitudeDeg', 'zoom', 'headingDeg', 'tiltDeg'] as const;

/** The view `t` (0–1) of the way from `from` to `to`, for the fields `to` gives. */
function between(from: ViewInit, to: ViewInit, t: number): ViewInit {
  const view: Record<string, number> = {};
  for (const key of KEYS) {
    const b = to[key];
    if (b === undefined) continue;
    const a = from[key] ?? b;
    view[key] = a + (b - a) * t;
  }
  return view as ViewInit;
}

/** The camera's current view. */
function viewOf(globe: Globe): ViewInit {
  const { longitudeDeg, latitudeDeg, zoom, headingDeg, tiltDeg } = globe.camera;
  return { longitudeDeg, latitudeDeg, zoom, headingDeg, tiltDeg };
}

/**
 * Plays `steps` frame by frame: only the recorder draws meanwhile, so each capture is one drawn frame and one step of
 * the engine clock. Holes are counted in every frame; black pixels where the brightest channel is below `darkBelow`;
 * pops in frames whose camera held still since the frame before.
 */
export async function recordPath(globe: Globe, steps: readonly PathStep[], darkBelow = 0): Promise<PathReport> {
  const canvas = document.querySelector('#globe');
  const report: PathReport = {
    frames: 0,
    staticFrames: 0,
    holes: 0,
    dark: 0,
    pops: 0,
    firstHoleFrame: -1,
    firstDarkFrame: -1,
    firstPopFrame: -1,
    first: undefined,
  };
  const restoreFrames = holdDisplayFrames();
  let previous: FrameCapture | undefined;
  /** Draws and checks one frame; `moved` when the camera moved since the previous one. */
  const draw = async (moved: boolean): Promise<void> => {
    const capture = await globe.captureFrame();
    checkFrame(globe, capture, capture.widthPx / Math.max(1, canvas?.clientWidth ?? 1), report, darkBelow);
    if (previous && !moved) {
      report.staticFrames++;
      checkPops(previous, capture, report);
    }
    previous = capture;
    report.frames++;
    // Let timers and network responses run between frames, as they do between display frames.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  try {
    for (const step of steps) {
      if ('jump' in step) {
        globe.jumpTo(step.jump);
        await draw(true);
      } else if ('move' in step) {
        const from = viewOf(globe);
        for (let k = 1; k <= step.frames; k++) {
          globe.jumpTo(between(from, step.move, k / step.frames));
          await draw(true);
        }
      } else if ('fly' in step) {
        let arrived = false;
        void globe.flyTo(step.fly, { durationMs: step.durationMs }).finally(() => (arrived = true));
        // The flight advances with the engine clock, one step per drawn frame; bounded in case it never ends.
        const frames = step.frames ?? step.durationMs / 8;
        for (let k = 0; !arrived && k < frames; k++) await draw(true);
        if (step.frames === undefined) await draw(true);
      } else if ('follow' in step) {
        // A flight started by an earlier step goes on: its frames move.
        for (let k = 0; k < step.follow; k++) await draw(true);
      } else {
        for (let k = 0; k < step.hold; k++) await draw(false);
      }
    }
  } finally {
    restoreFrames();
    globe.requestRender();
  }
  return report;
}

/**
 * Holds the display's frames while a recording draws its own: the engine's frame requests meanwhile are kept, under
 * ids far above the browser's, and handed to the real `requestAnimationFrame` when the returned function restores it.
 * Dropping them (`() => 0`) left the engine waiting for a frame that never came after the recording (TG-05).
 */
function holdDisplayFrames(): () => void {
  const request = window.requestAnimationFrame;
  const cancel = window.cancelAnimationFrame;
  const held = new Map<number, FrameRequestCallback>();
  let nextId = 1_000_000_000;
  window.requestAnimationFrame = (callback) => {
    held.set(nextId, callback);
    return nextId++;
  };
  window.cancelAnimationFrame = (id) => {
    if (!held.delete(id)) cancel.call(window, id);
  };
  return () => {
    window.requestAnimationFrame = request;
    window.cancelAnimationFrame = cancel;
    for (const callback of held.values()) request.call(window, callback);
  };
}
