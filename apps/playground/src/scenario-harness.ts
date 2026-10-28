import type { FrameCapture, Globe, ViewInit } from '@vibeglobe/core';
import { ACCEPTANCE_SCENARIOS } from './acceptance-scenarios.js';
import { checkPops } from './pops.js';
import { segments, type FrameScenario } from './scenario-paths.js';

export { countPops } from './pops.js';

/**
 * The frame-stepped scenario harness of M3 (plan §4.2, ADR 0012): a scenario is a view per frame index, with hold
 * windows (no view) between moves; the harness draws and reads every frame through `captureFrame()` and runs the
 * detectors in the page, so no frame crosses into the test. Loaded only when a test asks for it.
 */

/** The globe element's size in CSS pixels, which `screenToGeo` and `geoToScreen` use. */
interface CssSize {
  readonly widthPx: number;
  readonly heightPx: number;
}

/** What the detectors found: counts and the first frame of each defect, -1 when none. */
export interface ScenarioReport {
  frames: number;
  /** Frames compared for popping: the camera held still since the frame before. */
  staticFrames: number;
  /** Pixels inside the globe left transparent (the background shows through: a hole). */
  holes: number;
  firstHoleFrame: number;
  /** Where the first hole was, in CSS pixels, and what the globe shows there. */
  firstHole: { xPx: number; yPx: number; latitudeDeg: number; longitudeDeg: number } | undefined;
  /** Opaque pixels darker than the fixture allows inside the globe: lines or gaps at seams (F106, F110, F111). */
  dark: number;
  firstDarkFrame: number;
  /** Pixels that changed in one drawn frame faster than a 250 ms fade allows (F105). */
  pops: number;
  firstPopFrame: number;
  /** The first popped pixel, in device pixels, with its color before and after: where to look in CI's logs. */
  firstPop: { xPx: number; yPx: number; before: number[]; after: number[] } | undefined;
  /** Tiles whose terrain went back to a coarser level while the camera held still: a tile released early (F139). */
  terrainDrops: number;
  firstTerrainDropFrame: number;
  /**
   * The least, over the frames, of the tallest column of terrain above the ellipsoid's horizon, in device pixels
   * (F142); -1 when the scenario does not measure it.
   */
  minReliefAboveHorizonPx: number;
  /**
   * During motion, the largest share of pixels that changed by more than {@link JUMP_DELTA} in one frame, and that
   * frame: a jump of the view shows as a spike (M5, F152). 0 and -1 when nothing moved.
   */
  maxChangedShare: number;
  maxChangedFrame: number;
  /**
   * With `samples`: each frame's zoom, morph factor, relief factor, applied tilt (degrees), view mode, phase, heading
   * and the eye's height above the ellipsoid (meters).
   */
  samples: [number, number, number, number, string, string, number, number][];
}

/** Plays scenarios one after the other. */
function chain(...parts: FrameScenario[]): FrameScenario {
  return {
    frames: parts.reduce((sum, part) => sum + part.frames, 0),
    view(frame) {
      let start = 0;
      for (const part of parts) {
        if (frame < start + part.frames) return part.view(frame - start);
        start += part.frames;
      }
      return undefined;
    },
  };
}

const ROME = { longitudeDeg: 12.5, latitudeDeg: 41.9 };
const TOKYO = { longitudeDeg: 139.7, latitudeDeg: 35.7 };
/** Places of the fixture terrain (M4): the 4,000 m peak's valley, and the 1,500 m ridge along 46.5° N. */
const ALPS = { longitudeDeg: 6.86, latitudeDeg: 45.7 };
const RIDGE = { longitudeDeg: 8.5, latitudeDeg: 46.42 };

/** An orbit around `center`: the heading turns through `headings` at each zoom and tilt. */
function orbit(
  center: { longitudeDeg: number; latitudeDeg: number },
  zooms: readonly number[],
  tiltDeg: number,
  headings: readonly number[],
): ViewInit[] {
  return zooms.flatMap((zoom) => headings.map((headingDeg) => ({ ...center, zoom, tiltDeg, headingDeg })));
}

/** The frame-stepped scenarios by name. */
const SCENARIOS: Record<string, FrameScenario> = {
  ...ACCEPTANCE_SCENARIOS,
  // From orbit to street level over Rome, turning while it zooms (F105).
  'zoom-orbit-to-street': segments(
    [2, 4, 6, 8, 10, 12, 14, 16].map((zoom, i) => ({
      ...ROME,
      zoom,
      headingDeg: i * 15,
      tiltDeg: Math.min(40, i * 6),
    })),
    8,
    24,
  ),
  // Around each pole at three heights, tilted toward it (F110).
  'pole-orbit': segments(
    [90, -90].flatMap((pole) =>
      [3, 5, 7].flatMap((zoom) =>
        [0, 180, 360].map((headingDeg) => ({
          longitudeDeg: headingDeg,
          latitudeDeg: pole * 0.97,
          zoom,
          headingDeg,
          tiltDeg: 35,
        })),
      ),
    ),
    4,
    2,
  ),
  // Milan to Tokyo at city scale, then a burst of fast pans, one per frame, with still windows between (F562).
  'long-path': chain(
    segments(
      [
        { longitudeDeg: 9.19, latitudeDeg: 45.46, zoom: 7 },
        { longitudeDeg: 55.3, latitudeDeg: 25.2, zoom: 7 },
        { longitudeDeg: 77.2, latitudeDeg: 28.6, zoom: 7 },
        { ...TOKYO, zoom: 7 },
      ],
      12,
      10,
    ),
    segments(
      [0, 1, 2, 3, 4, 5].map((i) => ({ ...TOKYO, longitudeDeg: TOKYO.longitudeDeg + (i % 2 === 0 ? 0 : 3), zoom: 7 })),
      1,
      6,
    ),
  ),
  // Across ±180° at several zooms and tilts (F111).
  'antimeridian-pan': segments(
    [3, 6, 9].flatMap((zoom) =>
      [0, 45].flatMap((tiltDeg) =>
        [175, 185].map((lon) => ({ longitudeDeg: lon > 180 ? lon - 360 : lon, latitudeDeg: 20, zoom, tiltDeg })),
      ),
    ),
    6,
    4,
  ),
  // Terrain (M4). From about 50 km to 500 m above the peak's valley and back, tilted (F138, F139).
  // Holds of 16 frames: a level change morphs over 250 ms (15 frames at 60 Hz).
  'terrain-alps-zoom': segments(
    [9, 12, 15, 12, 9].map((zoom) => ({ ...ALPS, zoom, tiltDeg: 50 })),
    4,
    16,
  ),
  // Steep relief across tiles of different levels: tilting from 30° to 80° while circling the ridge (F137).
  'terrain-crack-sweep': segments(
    [
      [30, 0],
      [55, 60],
      [80, 120],
      [70, 200],
      [45, 280],
      [75, 360],
    ].map(([tiltDeg = 0, headingDeg = 0]) => ({ ...RIDGE, zoom: 13, tiltDeg, headingDeg })),
    4,
    6,
  ),
  // About 400 m up, 200 km south of the peak: its base stays behind the ellipsoid's horizon while the view pans it
  // from the screen's center to both edges (F142).
  'terrain-horizon-pan': {
    ...segments(
      [0, -20, -26, 0, 20, 26, 0].map((headingDeg) => ({
        longitudeDeg: 6.86,
        latitudeDeg: 44.03,
        zoom: 12,
        tiltDeg: 87,
        headingDeg,
      })),
      6,
      6,
    ),
    relief: true,
  },
  // M5. A continuous zoom from the globe to an oblique street view in Auto: every phase, 0.1 zoom per frame (F548,
  // F161, F167).
  'zoom-globe-to-street': {
    ...segments(
      [
        { ...ROME, zoom: 1 },
        { ...ROME, zoom: 18 },
      ],
      170,
      2,
    ),
    samples: true,
  },
  // The morph from the globe to the flat map and back, through the flattening band (F152).
  'morph-sweep': {
    ...segments(
      [3, 8, 3].map((zoom) => ({ ...ROME, zoom })),
      50,
      2,
    ),
    samples: true,
  },
  // Through the morph near both poles, flat and tilted (F160).
  'morph-poles': segments(
    [80, -80].flatMap((latitudeDeg) =>
      [
        [3, 0],
        [8, 0],
        [8, 40],
        [3, 40],
      ].map(([zoom = 0, tiltDeg = 0]) => ({ longitudeDeg: 30, latitudeDeg, zoom, tiltDeg, headingDeg: 0 })),
    ),
    12,
    2,
  ),
  // Fiji, across ±180° (F143).
  'terrain-antimeridian': segments(orbit({ longitudeDeg: 180, latitudeDeg: -17.5 }, [7, 10], 50, [0, 180]), 6, 4),
  // Svalbard, the Antarctic coast and both polar cap boundaries at ±85.05° (F143).
  'terrain-poles': chain(
    segments(orbit({ longitudeDeg: 16, latitudeDeg: 78.5 }, [7], 50, [0, 180]), 6, 4),
    segments(orbit({ longitudeDeg: 0, latitudeDeg: -70 }, [7], 50, [0, 180]), 6, 4),
    segments(orbit({ longitudeDeg: 0, latitudeDeg: 84.5 }, [6], 40, [0, 180]), 6, 4),
    segments(orbit({ longitudeDeg: 120, latitudeDeg: -84.5 }, [6], 40, [0, 180]), 6, 4),
  ),
};

/** Rows checked for holes, and the step of the coarse scan that finds the globe in a row. */
const ROW_STEP_PX = 2;
const SCAN_STEP_PX = 24;

function at(capture: FrameCapture, x: number, y: number, channel: number): number {
  return capture.rgba[(Math.round(y) * capture.widthPx + Math.round(x)) * 4 + channel] ?? 0;
}

/** {@link checkFrame}'s terrain height at a candidate hole. */
const ground = { heightMeters: 0, level: -1, noData: true };

/** Transparent pixels on a grid inside the globe, at least 2 px from its silhouette. */
/**
 * Counts, inside the globe and 2 px from its outline, the transparent pixels (holes) and, with `darkBelow`, the opaque
 * pixels whose brightest channel is below it (dark lines or gaps on a fixture whose pixels all have a bright channel).
 */
export function checkFrame(
  globe: Globe,
  capture: FrameCapture,
  view: CssSize,
  report: ScenarioReport,
  frame: number,
  darkBelow = 0,
): void {
  const scale = capture.widthPx / Math.max(1, view.widthPx);
  const hits = (x: number, y: number): boolean => globe.screenToGeo({ xPx: x / scale, yPx: y / scale }) !== undefined;
  // The globe covers one interval per row (its outline is convex): found by a coarse scan and two bisections, then
  // every pixel inside it, 2 px from its ends, must be opaque.
  const edge = (inside: number, outside: number, y: number): number => {
    while (Math.abs(outside - inside) > 1) {
      const middle = Math.round((inside + outside) / 2);
      if (hits(middle, y)) inside = middle;
      else outside = middle;
    }
    return inside;
  };
  for (let y = 2; y < capture.heightPx - 2; y += ROW_STEP_PX) {
    let inside = -1;
    for (let x = 0; x < capture.widthPx && inside < 0; x += SCAN_STEP_PX) if (hits(x, y)) inside = x;
    if (inside < 0) continue;
    const left = inside === 0 ? 0 : edge(inside, Math.max(0, inside - SCAN_STEP_PX), y);
    const right = hits(capture.widthPx - 1, y) ? capture.widthPx - 1 : edge(inside, capture.widthPx - 1, y);
    for (let x = left + 2; x <= right - 2; x++) {
      const opaque = at(capture, x, y, 3) === 255;
      const bright = Math.max(at(capture, x, y, 0), at(capture, x, y, 1), at(capture, x, y, 2));
      if (opaque && bright >= darkBelow) continue;
      // Near a nearly level stretch of the outline the band lies above or below: checked only when it matters.
      if (!hits(x, y - 2) || !hits(x, y + 2)) continue;
      if (opaque) {
        report.dark++;
        if (report.firstDarkFrame < 0) report.firstDarkFrame = frame;
        continue;
      }
      // The ray meets the ellipsoid here; where the terrain lies below the ellipsoid it may pass over the terrain to
      // the sky beyond its horizon. At or above it, the ray reached the ellipsoid inside the terrain: a hole.
      const where = globe.screenToGeo({ xPx: x / scale, yPx: y / scale });
      if (where && globe.elevationAt(where, ground).heightMeters < 0) continue;
      report.holes++;
      if (report.firstHoleFrame < 0) report.firstHoleFrame = frame;
      if (where) report.firstHole ??= { xPx: x / scale, yPx: y / scale, ...where };
    }
  }
}

/**
 * Plays scenario `name` frame by frame, drawing and reading each frame, and reports holes, pops in still windows and,
 * with `darkBelow`, dark pixels.
 */
/** An empty report, for a check of one frame. */
export function emptyReport(frames = 1): ScenarioReport {
  return {
    frames,
    staticFrames: 0,
    holes: 0,
    firstHoleFrame: -1,
    firstHole: undefined,
    dark: 0,
    firstDarkFrame: -1,
    pops: 0,
    firstPopFrame: -1,
    firstPop: undefined,
    terrainDrops: 0,
    firstTerrainDropFrame: -1,
    minReliefAboveHorizonPx: -1,
    maxChangedShare: 0,
    maxChangedFrame: -1,
    samples: [],
  };
}

/** A per-channel change that counts toward {@link ScenarioReport.maxChangedShare}. */
const JUMP_DELTA = 64;

/** The share of pixels whose color changed by more than {@link JUMP_DELTA} in some channel between two frames. */
function changedShare(previous: Pick<FrameCapture, 'rgba'>, capture: Pick<FrameCapture, 'rgba'>): number {
  let changed = 0;
  for (let i = 0; i < capture.rgba.length; i += 4) {
    for (let c = 0; c < 4; c++) {
      if (Math.abs((capture.rgba[i + c] ?? 0) - (previous.rgba[i + c] ?? 0)) > JUMP_DELTA) {
        changed++;
        break;
      }
    }
  }
  return changed / (capture.rgba.length / 4);
}

/** The terrain level each drawn tile shows, by tile. */
function terrainLevels(globe: Globe): Map<string, number> {
  const levels = new Map<string, number>();
  for (const tile of globe.surfaceTiles())
    if (tile.terrainLevel !== null) levels.set(`${tile.root}/${tile.level}/${tile.x}/${tile.y}`, tile.terrainLevel);
  return levels;
}

/** Counts the tiles whose terrain level fell since the previous still frame (F139). */
function countDrops(previous: Map<string, number>, current: Map<string, number>): number {
  let drops = 0;
  for (const [key, level] of current) if (level < (previous.get(key) ?? -1)) drops++;
  return drops;
}

/**
 * The motion measures of a frame (M5): with the frame before it while the camera moved, the share of pixels that
 * jumped; with `samples`, the camera state.
 */
function measureMotion(
  globe: Globe,
  scenario: FrameScenario,
  report: ScenarioReport,
  frame: number,
  moving: FrameCapture | false | undefined,
  capture: FrameCapture,
): void {
  if (moving) {
    const share = changedShare(moving, capture);
    if (share > report.maxChangedShare) {
      report.maxChangedShare = share;
      report.maxChangedFrame = frame;
    }
  }
  if (!scenario.samples) return;
  const camera = globe.camera;
  const { zoom, morphFactor, reliefFactor, tiltDeg, viewMode, phase, headingDeg, altitudeMeters } = camera;
  report.samples.push([zoom, morphFactor, reliefFactor, tiltDeg, viewMode, phase, headingDeg, altitudeMeters]);
}

/**
 * The tallest column of opaque pixels above the ellipsoid's horizon, in device pixels: in each column, from the first
 * opaque pixel down to the first row whose ray meets the ellipsoid (F142).
 */
function reliefAboveHorizonPx(globe: Globe, capture: FrameCapture, view: CssSize): number {
  const scale = capture.widthPx / Math.max(1, view.widthPx);
  const hits = (x: number, y: number): boolean => globe.screenToGeo({ xPx: x / scale, yPx: y / scale }) !== undefined;
  let tallest = 0;
  for (let x = 0; x < capture.widthPx; x += 4) {
    let top = 0;
    while (top < capture.heightPx && at(capture, x, top, 3) !== 255) top++;
    if (top >= capture.heightPx || hits(x, top)) continue;
    let sky = top;
    let ground = capture.heightPx - 1;
    if (!hits(x, ground)) continue;
    while (ground - sky > 1) {
      const middle = Math.floor((sky + ground) / 2);
      if (hits(x, middle)) ground = middle;
      else sky = middle;
    }
    if (ground - top > tallest) tallest = ground - top;
  }
  return tallest;
}

export async function recordScenario(
  globe: Globe,
  view: CssSize,
  name: string,
  darkBelow = 0,
  settleTiles = false,
): Promise<ScenarioReport> {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`no frame-stepped scenario "${name}"`);
  const report = emptyReport(scenario.frames);
  // Only the harness draws while it records: each capture is exactly one drawn frame, one step of the engine clock,
  // so a pixel's change between captures is its change in one frame.
  const restoreFrames = holdDisplayFrames();
  let previous: FrameCapture | undefined;
  let previousLevels = new Map<string, number>();
  const terrain = globe.terrainStats() !== undefined;
  let stillSince = -1;
  try {
    for (let frame = 0; frame < scenario.frames; frame++) {
      const next = scenario.view(frame);
      if (next) {
        globe.jumpTo(next);
        stillSince = frame + 1;
        // With `settleTiles`, the tiles each view asks for load before the next: the requests then follow the views
        // and the selection alone, not how many arrive while a slow page draws a frame (KB-230).
        if (settleTiles) await settleImagery(globe);
      }
      const capture = await globe.captureFrame();
      checkFrame(globe, capture, view, report, frame, darkBelow);
      if (previous && !next && frame > stillSince) {
        report.staticFrames++;
        checkPops(report, frame, previous, capture);
      }
      measureMotion(globe, scenario, report, frame, next && previous, capture);
      if (terrain) {
        const levels = terrainLevels(globe);
        if (!next && frame > stillSince) {
          const drops = countDrops(previousLevels, levels);
          report.terrainDrops += drops;
          if (drops > 0 && report.firstTerrainDropFrame < 0) report.firstTerrainDropFrame = frame;
        }
        previousLevels = levels;
      }
      if (scenario.relief) {
        const relief = reliefAboveHorizonPx(globe, capture, view);
        if (report.minReliefAboveHorizonPx < 0 || relief < report.minReliefAboveHorizonPx)
          report.minReliefAboveHorizonPx = relief;
      }
      previous = capture;
      // A capture can complete without leaving the task (WebGL2 reads back synchronously): let timers and network
      // responses run between frames, as they do between display frames.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    restoreFrames();
    globe.requestRender();
  }
  return report;
}

/** Draws frames until no imagery tile is queued, loading, decoding or waiting for upload (at most 10 s). */
async function settleImagery(globe: Globe): Promise<void> {
  const deadline = performance.now() + 10_000;
  for (;;) {
    await globe.captureFrame();
    const stats = globe.imageryStats();
    const pending = stats ? stats.queued + stats.loading + stats.decoding + stats.uploadsPending : 0;
    if (pending === 0 || performance.now() > deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
