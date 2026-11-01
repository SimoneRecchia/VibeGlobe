// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The small typed interface through which data layers draw (docs/internal/parallel-tracks.md, "Data layers track"). The layers
 * package owns the feature data and decides what changed; the renderer owns GPU buffers and draws them. The main
 * session implements this interface in `@vibeglobe/renderer`; tests use `RecordingRenderTarget` (`@vibeglobe/layers/testing`).
 */
import type { GeoPosition, ScreenPoint } from '@vibeglobe/core';

export {
  ANCHORS,
  ATTRIBUTE_COMPONENTS,
  BATCH_ATTRIBUTES,
  type BatchAttribute,
  type BatchDescriptor,
  type BatchHandle,
  type BatchKind,
  type BatchStringChannel,
  type FeatureGeometry,
  type LayerRenderTarget,
  type Placement,
} from '@vibeglobe/core';

/** Projection of geographic positions to the screen for the frame being drawn (label placement, clusters). */
export interface ScreenProjector {
  /** Screen point of a position, or undefined when it is behind the globe or outside the view. */
  geoToScreen(position: GeoPosition): ScreenPoint | undefined;
  /** The current zoom (Web Mercator zoom, continuous). */
  zoom(): number;
  /** The view's size in CSS pixels, when known (`createGlobeLayers` with an `element`): `geoToScreen` gives points outside it too. */
  viewportPx?(): { readonly widthPx: number; readonly heightPx: number };
}

/** Size of a laid-out text, from the renderer's glyph metrics (label collision boxes). */
export interface TextMeasurer {
  measure(text: string, sizePx: number): { readonly widthPx: number; readonly heightPx: number };
}

/**
 * A stand-in measurer until the renderer exposes its glyph metrics (docs/internal/parallel-tracks.md, hook request): 0.6 em per
 * character, 1.2 em high.
 */
export const estimatedTextMeasurer: TextMeasurer = {
  measure: (text, sizePx) => ({ widthPx: [...text].length * 0.6 * sizePx, heightPx: 1.2 * sizePx }),
};
