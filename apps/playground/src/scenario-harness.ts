import type { FrameCapture, Globe, ViewInit } from '@vibeglobe/core';

/**
 * The frame-stepped scenario harness of M3 (plan §4.2, ADR 0012): a scenario is a view per frame index, with hold
 * windows (no view) between moves; the harness draws and reads every frame through `captureFrame()` and runs the
 * detectors in the page, so no frame crosses into the test. Loaded only when a test asks for it.
 */

/** A frame-stepped scenario: how many frames, and the view of each (undefined: the camera holds still). */
interface FrameScenario {
  readonly frames: number;
  view(frame: number): ViewInit | undefined;
  /** Measure, in every frame, how far the terrain rises above the ellipsoid's horizon (F142). */
  readonly relief?: boolean;
}

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
  /** Tiles whose terrain went back to a coarser level while the camera held still: a tile released early (F139). */
  terrainDrops: number;
  firstTerrainDropFrame: number;
  /**
   * The least, over the frames, of the tallest column of terrain above the ellipsoid's horizon, in device pixels
   * (F142); -1 when the scenario does not measure it.
   */
  minReliefAboveHorizonPx: number;
}

/** Each segment of a scenario: `motion` frames moving from one view to the next, then `hold` frames still. */
function segments(views: readonly ViewInit[], motion: number, hold: number): FrameScenario {
  const step = motion + hold;
  return {
    frames: (views.length - 1) * step + hold,
    view(frame) {
      const segment = Math.floor(frame / step);
      const into = frame - segment * step;
      const from = views[segment];
      const to = views[segment + 1];
      if (!from || !to || into >= motion) return frame === 0 ? views[0] : undefined;
      const t = (into + 1) / motion;
      const mixed: Record<string, number> = {};
      for (const key of ['longitudeDeg', 'latitudeDeg', 'zoom', 'headingDeg', 'tiltDeg'] as const) {
        const a = (from as Record<string, number | undefined>)[key] ?? 0;
        const b = (to as Record<string, number | undefined>)[key] ?? 0;
        mixed[key] = a + (b - a) * t;
      }
      return mixed as ViewInit;
    },
  };
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

/** Per channel, the most a pixel may change in one drawn frame: a 250 ms fade at 60 Hz, plus rounding (plan §4.2). */
const FADE_STEP = 255 / 15;
const POP_SLACK = 4;
/** Rows checked for holes, and the step of the coarse scan that finds the globe in a row. */
const ROW_STEP_PX = 2;
const SCAN_STEP_PX = 24;

function at(capture: FrameCapture, x: number, y: number, channel: number): number {
  return capture.rgba[(Math.round(y) * capture.widthPx + Math.round(x)) * 4 + channel] ?? 0;
}

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
      report.holes++;
      if (report.firstHoleFrame < 0) report.firstHoleFrame = frame;
      const where = globe.screenToGeo({ xPx: x / scale, yPx: y / scale });
      if (where) report.firstHole ??= { xPx: x / scale, yPx: y / scale, ...where };
    }
  }
}

/** Pixels that changed in one frame faster than a fade allows (F105, F563). */
export function countPops(previous: Pick<FrameCapture, 'rgba'>, capture: Pick<FrameCapture, 'rgba'>): number {
  const limit = FADE_STEP + POP_SLACK;
  let pops = 0;
  for (let i = 0; i < capture.rgba.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      if (Math.abs((capture.rgba[i + c] ?? 0) - (previous.rgba[i + c] ?? 0)) > limit) {
        pops++;
        break;
      }
    }
  }
  return pops;
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
    terrainDrops: 0,
    firstTerrainDropFrame: -1,
    minReliefAboveHorizonPx: -1,
  };
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
): Promise<ScenarioReport> {
  const scenario = SCENARIOS[name];
  if (!scenario) throw new Error(`no frame-stepped scenario "${name}"`);
  const report = emptyReport(scenario.frames);
  // Only the harness draws while it records: each capture is exactly one drawn frame, one step of the engine clock,
  // so a pixel's change between captures is its change in one frame.
  const requestAnimationFrame = window.requestAnimationFrame;
  window.requestAnimationFrame = () => 0;
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
      }
      const capture = await globe.captureFrame();
      checkFrame(globe, capture, view, report, frame, darkBelow);
      if (previous && !next && frame > stillSince) {
        report.staticFrames++;
        const pops = countPops(previous, capture);
        report.pops += pops;
        if (pops > 0 && report.firstPopFrame < 0) report.firstPopFrame = frame;
      }
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
    window.requestAnimationFrame = requestAnimationFrame;
    globe.requestRender();
  }
  return report;
}
