import { rgba8Bytes } from '../cache/byte-size.js';
import { LOAD_ALL, LOAD_KEEP_IN_MEMORY, LOAD_PREFETCH, type ImagerySource } from './imagery-source.js';

/** How a layer combines with the layers below it (F246). */
export type ImageryBlend = 'normal' | 'multiply' | 'screen';

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
}

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
  /** The layer's sources in priority order (F220). */
  readonly sources: readonly ImagerySourceInfo[];
}

const DEG = 180 / Math.PI;

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
export const BLEND_CODES: Readonly<Record<ImageryBlend, number>> = { normal: 0, multiply: 1, screen: 2 };

/** A layer normalized from its input: sources and look, the look mutable at runtime. */
export interface StackEntry {
  readonly id: string;
  readonly sources: readonly ImagerySource[];
  /** A source of the chain has transparent areas (F242). */
  readonly transparent: boolean;
  opacity: number;
  visible: boolean;
  blend: ImageryBlend;
}

function isSource(input: ImageryLayerInput): input is ImagerySource {
  return 'request' in input;
}

/** The layers of `GlobeOptions.imagery`, normalized; throws `RangeError` for an empty chain or a duplicate id. */
export function stackEntries(inputs: readonly ImageryLayerInput[]): StackEntry[] {
  const entries = inputs.map((input): StackEntry => {
    if (isSource(input))
      return {
        id: input.id,
        sources: [input],
        transparent: input.transparent === true,
        opacity: 1,
        visible: true,
        blend: 'normal',
      };
    const first = input.sources[0];
    if (!first) throw new RangeError('An imagery layer needs at least one source');
    const entry: StackEntry = {
      id: input.id ?? first.id,
      sources: input.sources,
      transparent: input.sources.some((source) => source.transparent === true),
      opacity: 1,
      visible: true,
      blend: 'normal',
    };
    applyChanges(entry, input);
    return entry;
  });
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new RangeError(`Two imagery layers have the id "${entry.id}"`);
    ids.add(entry.id);
  }
  return entries;
}

/** Applies changes to a layer; throws `RangeError` for an opacity outside 0–1 or an unknown blend mode. */
export function applyChanges(entry: StackEntry, changes: ImageryLayerChanges): void {
  const { opacity, visible, blend } = changes;
  if (opacity !== undefined) {
    if (!(opacity >= 0 && opacity <= 1)) throw new RangeError(`Opacity ${String(opacity)} is not between 0 and 1`);
    entry.opacity = opacity;
  }
  if (visible !== undefined) entry.visible = visible;
  if (blend !== undefined) {
    if (!(blend in BLEND_CODES)) throw new RangeError(`Unknown blend mode "${String(blend)}"`);
    entry.blend = blend;
  }
}

/** True when a layer covers what is below it where it has a tile: fully opaque and blended normally. */
export function isOpaque(entry: StackEntry): boolean {
  return entry.opacity >= 1 && entry.blend === 'normal' && !entry.transparent;
}

/**
 * The deepest pinned level of each source, coarse first across sources: levels 0..N whose cumulative GPU size keeps
 * the sum over every base source within 1/8 of the GPU budget (M3 plan §3, risk 8).
 */
export function pinnedLevels(entries: readonly StackEntry[], gpuBudgetBytes: number): number[] {
  const sources = entries.flatMap((entry) => entry.sources);
  // Only the first source of a chain pins a base: the later ones serve finer levels or stand in (F247).
  const heads = entries.flatMap((entry) => entry.sources.map((_, index) => index === 0));
  const levels = sources.map(() => -1);
  let used = 0;
  for (let level = 0; level <= 25; level++) {
    let added = false;
    for (const [index, source] of sources.entries()) {
      if (!heads[index] || levels[index] !== level - 1) continue;
      const tiles = source.tiling.rootTilesX * source.tiling.rootTilesY * 4 ** level;
      const bytes = tiles * rgba8Bytes(source.tileSizePx, source.tileSizePx);
      if (used + bytes > gpuBudgetBytes / 8) continue;
      used += bytes;
      levels[index] = level;
      added = true;
    }
    if (!added) break;
  }
  return levels;
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
