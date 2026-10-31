// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Cross-fades style layers in and out as the zoom crosses their minzoom and maxzoom or their visibility changes
 * (F447), so a layer never pops in a single frame. The fade runs on the engine clock, like label fades (ADR 0029).
 */
import type { StyleLayer } from './style-layer.js';

/** The default fade duration, the style specification's default `transition.duration`. */
export const LAYER_FADE_MS = 300;

/** Per-layer opacity factors that follow each layer's zoom range and visibility over time. */
export class LayerFader {
  private readonly opacity = new Map<string, number>();
  private lastMs: number | undefined;

  constructor(private readonly durationMs = LAYER_FADE_MS) {}

  /**
   * Advances the fades to `nowMs` for the current zoom. A layer seen for the first time starts at its target, so the
   * initial view does not fade in.
   * @returns each layer's opacity factor (0 hidden, 1 fully drawn); layers at 0 need not be drawn.
   */
  update(nowMs: number, zoom: number, layers: readonly StyleLayer[]): ReadonlyMap<string, number> {
    const step = this.lastMs === undefined || this.durationMs <= 0 ? 1 : (nowMs - this.lastMs) / this.durationMs;
    this.lastMs = nowMs;
    const live = new Set<string>();
    for (const layer of layers) {
      live.add(layer.id);
      const target = layer.visible && layer.inZoomRange(zoom) ? 1 : 0;
      const current = this.opacity.get(layer.id);
      if (current === undefined || step >= 1) {
        this.opacity.set(layer.id, target);
        continue;
      }
      const next = current < target ? Math.min(target, current + step) : Math.max(target, current - step);
      this.opacity.set(layer.id, next);
    }
    for (const id of this.opacity.keys()) if (!live.has(id)) this.opacity.delete(id);
    return this.opacity;
  }

  /** Whether some layer is still fading (the renderer keeps drawing frames until it is not). */
  fading(zoom: number, layers: readonly StyleLayer[]): boolean {
    return layers.some((layer) => {
      const target = layer.visible && layer.inZoomRange(zoom) ? 1 : 0;
      const current = this.opacity.get(layer.id);
      return current !== undefined && current !== target;
    });
  }
}
