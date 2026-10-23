/** The public types of vector tile layers (ADR 0131). */
import type { ScreenPoint, TileTransport } from '@vibeglobe/core';
import type { PlacedLabel } from './label-placer.js';
import type { VectorFeatureEvent } from './vector-interaction.js';
import type { PickedVectorFeature } from './vector-picking.js';
import type { VectorStyle } from './vector-style.js';
import type { VectorTileTarget } from './vector-target.js';

/** Options of {@link addVectorTiles}. */
export interface VectorTilesOptions {
  /** The style: its JSON, or the URL to fetch it from. */
  readonly style: unknown;
  /** Creates the renderer's target from `context.renderer` (`createVectorTileTarget` of the renderer). */
  readonly target: (renderer: unknown) => VectorTileTarget;
  /** The transport of tile, TileJSON, glyph and sprite requests; `fetchTransport()` by default. */
  readonly transport?: TileTransport;
  /** `fetch` for the style, TileJSON, glyph and sprite documents; the global one by default. */
  readonly fetch?: typeof fetch;
  /** The element whose pointer events hover and click features (the globe's container); none without it. */
  readonly element?: HTMLElement | undefined;
  /** A CSS font family drawn locally for characters the style's glyphs lack (CJK, F448). */
  readonly localFontFamily?: string;
}

/** A vector tile layer on a globe. */
export interface VectorTileLayer {
  /** The style, changeable at runtime (paint, layout, filters, layers; F450). */
  readonly style: VectorStyle;
  /** Sets feature-state of a feature (F446): its paint follows on the next frame. */
  setFeatureState(
    feature: { readonly source: string; readonly id: number | string },
    state: Record<string, unknown>,
  ): void;
  /** The labels the last frame placed, with their screen boxes (F449). */
  placedLabels(): readonly PlacedLabel[];
  /** Tiles requested or being laid out and not ready yet, over every source (tests wait for 0). */
  loadingTiles(): number;
  /** Every tile URL requested so far, per source (tests: F442, F450). */
  requestLog(source?: string): readonly string[];
  /** Diagnostics: the drawn tiles of the last frame, as `z/x/y` of the drawn tile → target. */
  drawnTiles(): readonly { readonly tile: string; readonly target: string; readonly standIn: boolean }[];
  /** Every feature drawn under a screen point, topmost first (labels, then layers from the top down; F459). */
  queryRenderedFeatures(point: ScreenPoint): PickedVectorFeature[];
  /**
   * Shows names in a language (F454): every symbol layer whose `text-field` reads a name uses `name:<language>`, then
   * `name_<language>`, then `name`. The tiles are laid out again from their kept bytes, not downloaded.
   */
  setLanguage(language: string): void;
  /** Subscribes to hover and click events of features (with `element` given); returns the unsubscribe function. */
  on(listener: (event: VectorFeatureEvent) => void): () => void;
  /** Removes the layer and frees its resources. */
  remove(): void;
}
