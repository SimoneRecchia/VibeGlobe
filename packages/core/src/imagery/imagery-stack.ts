import type { ImagerySource } from './imagery-source.js';

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

/** A layer's current look, as `Globe.imageryLayers` reports and changes it. */
export interface ImageryLayerState {
  readonly id: string;
  readonly opacity: number;
  readonly visible: boolean;
  readonly blend: ImageryBlend;
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
}

/** Blend modes as the renderer's per-draw numbers (`TileDrawOverlay.blends`). */
export const BLEND_CODES: Readonly<Record<ImageryBlend, number>> = { normal: 0, multiply: 1, screen: 2 };

/** A layer normalized from its input: sources and look, the look mutable at runtime. */
export interface StackEntry {
  readonly id: string;
  readonly sources: readonly ImagerySource[];
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
    if (isSource(input)) return { id: input.id, sources: [input], opacity: 1, visible: true, blend: 'normal' };
    const first = input.sources[0];
    if (!first) throw new RangeError('An imagery layer needs at least one source');
    const entry = {
      id: input.id ?? first.id,
      sources: input.sources,
      opacity: 1,
      visible: true,
      blend: 'normal' as const,
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
  return entry.opacity >= 1 && entry.blend === 'normal';
}
