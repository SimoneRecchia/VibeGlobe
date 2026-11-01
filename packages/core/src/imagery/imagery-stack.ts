// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { rgba8Bytes } from '../cache/byte-size.js';
import type { Camera } from '../camera/camera.js';
import { cameraZoom } from '../camera/zoom.js';
import { coveredTiles, LOAD_ALL, LOAD_KEEP_IN_MEMORY, LOAD_PREFETCH, type ImagerySource } from './imagery-source.js';
import { RAD_TO_DEG as DEG } from '../geodesy/geodesic-angles.js';

/**
 * How a layer combines with the layers below it (F246). `'night'` adds the layer as light on the night side of the
 * atmosphere's day and night (`AtmosphereSettings.dayNight`, F647), a city-lights image for example, and shows nothing
 * by day or without it.
 */
export type ImageryBlend = 'normal' | 'multiply' | 'screen' | 'night';

/**
 * An imagery layer of `GlobeOptions.imagery` (docs/plan/api.md, "Layer composition"): a chain of sources in priority
 * order, each tile coming from the first source that has it (F247, F248), drawn with an opacity and a blend mode over
 * the layers below (F244, F246).
 */
export interface ImageryLayerOptions {
  /** Unique among the layers; by default the first source's id. */
  readonly id?: string;
  /** The sources in priority order; at least one. */
  readonly sources: readonly ImagerySource[];
  /** 0 to 1 (default 1). */
  readonly opacity?: number;
  /** Default true; a hidden layer requests no tiles (F245). */
  readonly visible?: boolean;
  /** Default 'normal'. */
  readonly blend?: ImageryBlend;
  /**
   * Matches the tones of the chain's sources (F249, ADR 0044): a later source's colors are scaled toward the first
   * source's where both show, so neither a switch nor a boundary between them shows (default true; false shows the
   * sources' own colors). `'below'` matches every source of the layer to the imagery under it instead, measured where
   * both show on the same tiles: the opaque layer below for a transparent layer, the world base image for the lowest
   * opaque layer, so the layers' tones follow one another across levels and borders (F633).
   */
  readonly harmonize?: Harmonize;
  /**
   * Fades the layer in with the camera's zoom (F635): hidden up to `fromZoom` (no tile requested), its opacity growing
   * linearly to full at `toZoom`, the same over the whole view, so a layer replaces the one below without a boundary at
   * the tiles' edges or a step between levels. Absent: shown at every zoom.
   */
  readonly fadeIn?: ZoomFade;
  /**
   * With `harmonize: 'below'`, how the matching fades with the camera's zoom (F638): at full strength up to `fromZoom`,
   * weakening to none at `toZoom`, so the layer shows its own colors where its detail outgrows the imagery below.
   * Absent: full strength at every zoom.
   */
  readonly harmonizeFade?: ZoomFade;
}

/** A fade with the camera's Mercator zoom (`ImageryLayerOptions.fadeIn`, F635). */
export interface ZoomFade {
  readonly fromZoom: number;
  readonly toZoom: number;
}

/** How a layer matches tones (`ImageryLayerOptions.harmonize`). */
export type Harmonize = boolean | 'below';

/** A layer of `GlobeOptions.imagery`: a single source, or a layer with a chain of sources and its look. */
export type ImageryLayerInput = ImagerySource | ImageryLayerOptions;

/** A source's declared metadata, as `Globe.imageryLayers.list()` reports it (F220). */
export interface ImagerySourceInfo {
  readonly id: string;
  readonly crs: string;
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly tileSizePx: number;
  readonly pixelRatio: number;
  /** Coverage rectangles in degrees; absent for the whole world. */
  readonly coverageDeg?: readonly { westDeg: number; southDeg: number; eastDeg: number; northDeg: number }[];
  readonly attribution: readonly { readonly text: string; readonly url?: string }[];
  readonly maxRequestsPerHost?: number;
  readonly maxRequestsPerSecond?: number;
  /** Whether the source's tiles may stay in memory off screen and load ahead (its loading flags now, F220, F290). */
  readonly keepInMemory: boolean;
  readonly prefetch: boolean;
  /** Whether its requests carry credentials (F220). */
  readonly authenticated: boolean;
}

/** A layer's current look, as `Globe.imageryLayers` reports and changes it, with its sources' metadata. */
export interface ImageryLayerState {
  readonly id: string;
  readonly opacity: number;
  readonly visible: boolean;
  readonly blend: ImageryBlend;
  /** How the layer's tones are matched (F249, F633). */
  readonly harmonize: Harmonize;
  /** The layer's sources in priority order (F220). */
  readonly sources: readonly ImagerySourceInfo[];
}

/** The metadata of a source, in degrees (F220). */
export function sourceInfo(source: ImagerySource): ImagerySourceInfo {
  const flags = source.loadingFlags?.() ?? LOAD_ALL;
  return {
    id: source.id,
    crs: source.tiling.crs,
    minLevel: source.minLevel,
    maxLevel: source.maxLevel,
    tileSizePx: source.tileSizePx,
    pixelRatio: source.pixelRatio,
    ...(source.coverage
      ? {
          coverageDeg: source.coverage.map((r) => ({
            westDeg: r.westRad * DEG,
            southDeg: r.southRad * DEG,
            eastDeg: r.eastRad * DEG,
            northDeg: r.northRad * DEG,
          })),
        }
      : {}),
    attribution: (source.attribution ?? []).map(({ text, url }) => ({ text, ...(url ? { url } : {}) })),
    ...(source.maxRequestsPerHost === undefined ? {} : { maxRequestsPerHost: source.maxRequestsPerHost }),
    ...(source.maxRequestsPerSecond === undefined ? {} : { maxRequestsPerSecond: source.maxRequestsPerSecond }),
    keepInMemory: (flags & LOAD_KEEP_IN_MEMORY) !== 0,
    prefetch: (flags & LOAD_PREFETCH) !== 0,
    authenticated: source.authenticated === true,
  };
}

/** What `Globe.imageryLayers.set` can change. */
export interface ImageryLayerChanges {
  readonly opacity?: number;
  readonly visible?: boolean;
  readonly blend?: ImageryBlend;
  readonly harmonize?: Harmonize;
}

/**
 * The imagery layers of a globe at runtime (F243–F246): their order, bottom first, and each one's opacity, visibility
 * and blend mode. Changes show on the next frame.
 */
export interface ImageryLayers {
  /** The layers, bottom first. */
  list(): readonly ImageryLayerState[];
  /** Changes a layer's look; throws a `GlobeError` ('invalid-option') for an unknown id or a value out of range. */
  set(id: string, changes: ImageryLayerChanges): void;
  /** Moves a layer to `index` in the bottom-first order (clamped to the list). */
  move(id: string, index: number): void;
  /**
   * Adds a layer at `index` in the bottom-first order (default: on top) on a running globe (track A hook 2). Throws a
   * `GlobeError` ('invalid-option') for a source with invalid metadata or an id already taken, and before the imagery
   * starts (after `ready`) or on a globe created without `workers`.
   */
  add(input: ImageryLayerInput, index?: number): void;
  /** Removes a layer and releases its tiles; false when no layer has the id. */
  remove(id: string): boolean;
}

/** Blend modes as the renderer's per-draw numbers (`TileDrawOverlay.blends`). */
export const BLEND_CODES: Readonly<Record<ImageryBlend, number>> = { normal: 0, multiply: 1, screen: 2, night: 3 };

/** A layer normalized from its input: sources and look, the look mutable at runtime. */
export interface StackEntry {
  readonly id: string;
  readonly sources: readonly ImagerySource[];
  /** A source of the chain has transparent areas (F242). */
  readonly transparent: boolean;
  opacity: number;
  visible: boolean;
  blend: ImageryBlend;
  harmonize: Harmonize;
  fadeIn?: ZoomFade;
  /** The share of its opacity the layer shows at the frame's zoom (its `fadeIn`), set each frame (F635, F670). */
  zoomOpacity?: number;
  harmonizeFade?: ZoomFade;
  /** The strength of its matching to the imagery below at the frame's zoom (its `harmonizeFade`), each frame (F638). */
  toneStrength?: number;
}

function isSource(input: ImageryLayerInput): input is ImagerySource {
  return 'request' in input;
}

/** The layers of `GlobeOptions.imagery`, normalized; throws `RangeError` for an empty chain or a duplicate id. */
export function stackEntries(inputs: readonly ImageryLayerInput[]): StackEntry[] {
  const entries = inputs.map((input): StackEntry => {
    const layer = isSource(input) ? undefined : input;
    const sources = isSource(input) ? [input] : input.sources;
    const first = sources[0];
    if (!first) throw new RangeError('An imagery layer needs at least one source');
    const entry: StackEntry = {
      id: layer?.id ?? first.id,
      sources,
      transparent: sources.some((source) => source.transparent === true),
      opacity: 1,
      visible: true,
      blend: 'normal',
      harmonize: true,
    };
    if (!layer) return entry;
    applyChanges(entry, layer);
    if (layer.fadeIn) entry.fadeIn = zoomFade(layer.fadeIn, 'fadeIn');
    if (layer.harmonizeFade) entry.harmonizeFade = zoomFade(layer.harmonizeFade, 'harmonizeFade');
    return entry;
  });
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new RangeError(`Two imagery layers have the id "${entry.id}"`);
    ids.add(entry.id);
  }
  return entries;
}

/** A layer's fade by zoom, checked: throws `RangeError` unless both zooms are finite and in order. */
function zoomFade({ fromZoom, toZoom }: ZoomFade, name: string): ZoomFade {
  if (!(Number.isFinite(fromZoom) && Number.isFinite(toZoom) && fromZoom < toZoom))
    throw new RangeError(`${name}: finite fromZoom < toZoom`);
  return { fromZoom, toZoom };
}

/** Applies changes to a layer; throws `RangeError` for an opacity outside 0–1 or an unknown blend mode. */
export function applyChanges(entry: StackEntry, changes: ImageryLayerChanges): void {
  const { opacity, visible, blend, harmonize } = changes;
  if (harmonize !== undefined) {
    if (harmonize !== true && harmonize !== false && harmonize !== 'below')
      throw new RangeError(`Unknown harmonize value "${String(harmonize)}"`);
    entry.harmonize = harmonize;
  }
  if (opacity !== undefined) {
    if (!(opacity >= 0 && opacity <= 1)) throw new RangeError(`Opacity ${String(opacity)} is not between 0 and 1`);
    entry.opacity = opacity;
  }
  if (visible !== undefined) entry.visible = visible;
  if (blend !== undefined) {
    if (!Object.hasOwn(BLEND_CODES, blend)) throw new RangeError(`Unknown blend mode "${String(blend)}"`);
    entry.blend = blend;
  }
}

/** True when a layer covers what is below it where it has a tile: fully opaque and blended normally. */
export function isOpaque(entry: StackEntry): boolean {
  return shownOpacity(entry) >= 1 && entry.blend === 'normal' && !entry.transparent;
}

/** The opacity a layer shows with at this frame's zoom: its own times its zoom fade's (F635). */
export function shownOpacity(entry: StackEntry): number {
  return entry.opacity * (entry.zoomOpacity ?? 1);
}

/**
 * The least time a layer's zoom fade takes to go from one end to the other, milliseconds (F670): a fast zoom through a
 * fade changes the layer's opacity no faster, so a layer never turns on or off like a light; a slower zoom moves it with
 * the zoom, as before. (Tone matching fades over several levels, `harmonizeFade`: slow enough at any zoom speed.)
 */
export const LAYER_FADE_MS = 600;

/**
 * Sets each layer's tone matching at the camera's Mercator zoom (F638) and moves its share of its opacity toward its value
 * there (F635), by at most the time since the last call (`time[0]` now, `time[1]` the last call, written here, engine
 * milliseconds; no time moves it at once) over {@link LAYER_FADE_MS} (F670). When a layer turns opaque or
 * translucent, every draw changes layers: `snaps` (the imagery's cross-fades, then each overlay slot's) show the next
 * frame at once, with no cross-fade from what they showed, which was the same imagery; when a layer appears or vanishes
 * under a shown one, whose overlay slot moves, the overlay slots' do (KB-307). Returns true while an opacity has not
 * reached its value. Allocates nothing.
 */
export function fadeByZoom(
  entries: readonly { readonly entry: StackEntry }[],
  camera: Camera,
  time?: Float64Array,
  snaps: readonly { snapNext: boolean }[] = [],
): boolean {
  const zoom = cameraZoom(camera);
  // NaN (no time) moves every value to its own at once.
  const most = time ? ((time[0] ?? 0) - (time[1] ?? Number.NaN)) / LAYER_FADE_MS : Number.NaN;
  if (time) time[1] = time[0] ?? 0;
  let fading = false;
  let appeared = false;
  // The first snap to set: 0 every draw's, 1 the overlay slots', past the end none.
  let snap = snaps.length;
  for (const { entry } of entries) {
    entry.toneStrength = 1 - ramp(entry.harmonizeFade, zoom, 0);
    const target = ramp(entry.fadeIn, zoom, 1);
    // A layer's first frame starts at its value: a layer added on a running globe does not fade from full.
    const before = (entry.zoomOpacity ??= target);
    const opaque = isOpaque(entry);
    const after = (entry.zoomOpacity = toward(before, target, most));
    if (after !== target) fading = true;
    if (opaque !== isOpaque(entry)) snap = 0;
    else if (before <= 0 !== after <= 0) appeared = true;
    else if (appeared && after > 0 && snap > 1) snap = 1;
  }
  for (; snap < snaps.length; snap++) (snaps[snap] as { snapNext: boolean }).snapNext = true;
  return fading;
}

/** Whether a view at Mercator zoom `zoom` draws the layer: visible, not transparent, and within its fade (F671). */
export function shownAt(entry: StackEntry, zoom: number): boolean {
  return entry.visible && entry.opacity > 0 && ramp(entry.fadeIn, zoom, 1) > 0;
}

/** `value` moved toward `target` by at most `most` (NaN: all the way). */
function toward(value: number, target: number, most: number): number {
  return value < target - most ? value + most : value > target + most ? value - most : target;
}

/** Where `zoom` lies across a fade, 0 to 1; `absent` without one. */
function ramp(fade: ZoomFade | undefined, zoom: number, absent: number): number {
  return fade ? Math.min(1, Math.max(0, (zoom - fade.fromZoom) / (fade.toZoom - fade.fromZoom))) : absent;
}

/** The deepest first level of a source that still pins its tiles within its coverage (F634). */
const MAX_PINNED_START = 8;

/**
 * The deepest pinned level of each source: levels from the source's first up to N, a level per source in turn, whose
 * cumulative GPU size keeps the sum over every base source within 1/8 of the GPU budget (M3 plan §3, risk 8). A source
 * that starts deeper than level 0 pins from its first level, only the tiles within its coverage (F634).
 */
export function pinnedLevels(entries: readonly StackEntry[], gpuBudgetBytes: number): number[] {
  const sources = entries.flatMap((entry) => entry.sources);
  // One source of a chain pins a base, the later ones serving finer levels or standing in (F247): the first that has
  // level 0, so a chain over a world source from a source that starts deeper pins the world's low levels (KB-218); in
  // a chain without one, its first source, from its first level (F634).
  const heads = entries.flatMap((entry) => {
    const base = Math.max(
      0,
      entry.sources.findIndex((source) => !source.minLevel),
    );
    return entry.sources.map((_, index) => index === base);
  });
  // A source starting deeper than this pins nothing: its first level has too many tiles to count, let alone pin.
  const levels = sources.map((source) => (source.minLevel > MAX_PINNED_START ? -2 : Math.max(0, source.minLevel) - 1));
  const firsts = [...levels];
  let used = 0;
  // A level per source in turn, each from its own first, coarse first: every layer gets its lowest levels.
  for (let round = 0; round <= 25; round++) {
    let added = false;
    for (const [index, source] of sources.entries()) {
      const level = (levels[index] ?? -2) + 1;
      if (!heads[index] || (firsts[index] ?? -2) < -1 || level - 1 - (firsts[index] ?? 0) !== round) continue;
      const tiles =
        (firsts[index] ?? -1) < 0
          ? source.tiling.rootTilesX * source.tiling.rootTilesY * 4 ** level
          : coveredTiles(source, level);
      const bytes = tiles * rgba8Bytes(source.tileSizePx, source.tileSizePx);
      if (used + bytes > gpuBudgetBytes / 8) continue;
      used += bytes;
      levels[index] = level;
      added = true;
    }
    if (!added) break;
  }
  return levels.map((level, index) => (level === firsts[index] || level < 0 ? -1 : level));
}

/** The reference systems of the engine's tiling schemes (Web Mercator XYZ and the two-root geographic pyramid). */
const SUPPORTED_CRS = new Set(['EPSG:3857', 'EPSG:4326']);

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isPositiveInteger = (value: unknown): boolean => Number.isInteger(value) && (value as number) > 0;

/** A configuration value as text for a message, whatever it is (an object without a usable `toString` included). */
function shown(value: unknown): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * What is wrong with a source's metadata (F220), or undefined when it is valid: its reference system, level range,
 * tile size and pixel ratio, coverage rectangles, request limits and time limits, and its credits.
 */
export function sourceProblem(source: ImagerySource): string | undefined {
  const { id, tiling, minLevel, maxLevel } = source as Partial<ImagerySource>;
  if (typeof id !== 'string' || id.length === 0) return 'has no id';
  if (typeof tiling !== 'object' || !SUPPORTED_CRS.has(shown(tiling.crs)))
    return `uses the unknown reference system ${shown((tiling as { crs?: unknown } | undefined)?.crs)}`;
  if (
    !Number.isInteger(minLevel) ||
    !Number.isInteger(maxLevel) ||
    (minLevel as number) < 0 ||
    (maxLevel as number) > 30
  )
    return `has levels ${shown(minLevel)} to ${shown(maxLevel)}: they must be integers from 0 to 30`;
  if ((minLevel as number) > (maxLevel as number))
    return `has a minimum level ${shown(minLevel)} above its maximum ${shown(maxLevel)}`;
  if (!isPositiveInteger(source.tileSizePx)) return `has a tile size of ${shown(source.tileSizePx)} pixels`;
  if (!isFiniteNumber(source.pixelRatio) || source.pixelRatio < 1)
    return `has a pixel ratio of ${shown(source.pixelRatio)}`;
  for (const area of source.coverage ?? []) {
    const { westRad, southRad, eastRad, northRad } = area;
    if (![westRad, southRad, eastRad, northRad].every(isFiniteNumber) || southRad >= northRad || westRad === eastRad)
      return 'has a coverage rectangle that is empty, inverted or not finite';
  }
  if (source.maxRequestsPerHost !== undefined && !isPositiveInteger(source.maxRequestsPerHost))
    return `allows ${shown(source.maxRequestsPerHost)} requests per host`;
  if (
    source.maxRequestsPerSecond !== undefined &&
    !(isFiniteNumber(source.maxRequestsPerSecond) && source.maxRequestsPerSecond >= 1)
  )
    return `declares a rate limit of ${shown(source.maxRequestsPerSecond)} requests per second`;
  const timeouts = source.timeoutsMs;
  if (
    timeouts &&
    !(
      isFiniteNumber(timeouts.firstByteMs) &&
      timeouts.firstByteMs > 0 &&
      isFiniteNumber(timeouts.totalMs) &&
      timeouts.totalMs > 0
    )
  )
    return 'has time limits that are not positive numbers';
  for (const attribution of source.attribution ?? [])
    if (typeof attribution?.text !== 'string') return 'has a credit without text';
  return undefined;
}

/**
 * The layers of `GlobeOptions.imagery` whose sources are all valid (F220); every other layer is left out and reported
 * through `refused` with a descriptive message, so the engine still draws the valid ones.
 */
export function validStack(inputs: readonly ImageryLayerInput[], refused: (message: string) => void): StackEntry[] {
  const entries: StackEntry[] = [];
  for (const entry of stackEntries(inputs)) {
    const problems = entry.sources.map((source) => [source, sourceProblem(source)] as const).filter(([, p]) => p);
    if (problems.length === 0) entries.push(entry);
    else
      for (const [source, problem] of problems)
        refused(
          `Imagery source "${shown((source as Partial<ImagerySource>).id)}" ${shown(problem)}; its layer "${entry.id}" is left out`,
        );
  }
  return entries;
}
