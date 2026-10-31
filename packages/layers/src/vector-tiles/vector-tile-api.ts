// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** The public types of vector tile layers (ADR 0131). */
import type { ScreenPoint, TileTransport } from '@vibeglobe/core';
import type { LabelPropertyValue, LabelsHidden } from './placed-labels.js';
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
  /**
   * Rewrites every URL the style leads to (TileJSON, tiles, glyphs, sprites) before it is requested, so a style loads
   * unchanged against another host (F444; MapLibre's `transformRequest`). The style's own URL is not rewritten.
   */
  readonly transformUrl?: (url: string) => string;
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
  /**
   * The labels the last frame placed and drew, with their screen boxes (F449); hidden ones (`setLabelsHidden`) only
   * while they fade out.
   */
  placedLabels(): readonly PlacedLabel[];
  /**
   * Where the last frame placed the labels of a style layer, by the value of a feature property (F652): each label's
   * anchor on the ground (`position`) and on screen (`screenPoint`), for example to grow a marker out of a country's
   * name. Labels hidden with `setLabelsHidden` are included; of several labels with the same value, the first.
   */
  labelAnchors(layerId: string, property: string): ReadonlyMap<LabelPropertyValue, PlacedLabel>;
  /**
   * Keeps labels of a style layer placed without drawing them (F652): they keep their room in collision, so the labels
   * around them stay where they are, and `labelAnchors` still lists them, while they fade out over the label fade
   * (300 ms on the engine clock) and back in when shown again. `true` hides every label of the layer, `false` none,
   * `{ property, values }` those whose feature property has one of the values; each call replaces the layer's last.
   */
  setLabelsHidden(layerId: string, labels: LabelsHidden): void;
  /**
   * Tiles requested or being laid out and not ready yet, over every source, and glyph ranges labels wait for (tests
   * wait for 0).
   */
  loadingTiles(): number;
  /** Every tile URL requested so far, per source (tests: F442, F450). */
  requestLog(source?: string): readonly string[];
  /** Diagnostics: the drawn tiles of the last frame, as `z/x/y` of the drawn tile → target. */
  drawnTiles(): readonly { readonly tile: string; readonly target: string; readonly standIn: boolean }[];
  /**
   * Main-thread time of the last frame's vector tile work in milliseconds: tile choice, draping, paint, label
   * placement and uploads (F443; decoding and tessellation run in the workers).
   */
  frameTimeMs(): number;
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
