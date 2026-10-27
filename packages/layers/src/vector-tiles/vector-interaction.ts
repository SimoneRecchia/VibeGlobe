// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Hover and click on vector tile features (F459): pointer events of an element (mouse, pen and touch alike) picked on
 * the CPU (`vector-picking.ts`), turned into `hover`, `hoverend` and `click` events with the feature's layer,
 * properties and position, and into feature-state: `hover` while the pointer is over a feature, `selected` on the last
 * clicked one, so styles highlight them with `['feature-state', …]` on the next frame.
 */
import type { ScreenPoint } from '@vibeglobe/core';
import type { PickedVectorFeature } from './vector-picking.js';

/** A feature event. */
export interface VectorFeatureEvent {
  readonly type: 'hover' | 'hoverend' | 'click';
  readonly feature: PickedVectorFeature;
  readonly point: ScreenPoint;
}

/** Movement below which a press and release count as a click, CSS pixels. */
const CLICK_SLOP_PX = 5;

const same = (a: PickedVectorFeature | undefined, b: PickedVectorFeature | undefined) =>
  a !== undefined && b !== undefined && a.layerId === b.layerId && a.id === b.id && a.source === b.source;

/** Routes pointer input to feature events and states. */
export class VectorInteraction {
  private readonly listeners = new Set<(event: VectorFeatureEvent) => void>();
  private hovered: PickedVectorFeature | undefined;
  private selected: PickedVectorFeature | undefined;
  private pressAt: ScreenPoint | undefined;

  constructor(
    private readonly pick: (point: ScreenPoint) => readonly PickedVectorFeature[],
    private readonly setState: (feature: PickedVectorFeature, state: Record<string, unknown>) => void,
  ) {}

  /** Subscribes to feature events; returns the unsubscribe function. */
  on(listener: (event: VectorFeatureEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The pointer moved to a point (or left, with undefined). */
  move(point: ScreenPoint | undefined): void {
    const hit = point === undefined ? undefined : this.pick(point)[0];
    if (same(hit, this.hovered)) return;
    if (this.hovered !== undefined) {
      this.setState(this.hovered, { hover: false });
      this.emit({ type: 'hoverend', feature: this.hovered, point: point ?? { xPx: -1, yPx: -1 } });
    }
    this.hovered = hit;
    if (hit !== undefined && point !== undefined) {
      this.setState(hit, { hover: true });
      this.emit({ type: 'hover', feature: hit, point });
    }
  }

  /** A press started. */
  down(point: ScreenPoint): void {
    this.pressAt = point;
  }

  /** A press ended: a click when the pointer barely moved. */
  up(point: ScreenPoint): void {
    const at = this.pressAt;
    this.pressAt = undefined;
    if (at === undefined || Math.hypot(point.xPx - at.xPx, point.yPx - at.yPx) > CLICK_SLOP_PX) return;
    const hit = this.pick(point)[0];
    if (this.selected !== undefined && !same(hit, this.selected)) this.setState(this.selected, { selected: false });
    this.selected = hit;
    if (hit === undefined) return;
    this.setState(hit, { selected: true });
    this.emit({ type: 'click', feature: hit, point });
  }

  /** Follows an element's pointer events (positions relative to it); returns the function that stops. */
  attach(element: HTMLElement): () => void {
    const at = (event: PointerEvent): ScreenPoint => {
      const box = element.getBoundingClientRect();
      return { xPx: event.clientX - box.left, yPx: event.clientY - box.top };
    };
    const move = (event: PointerEvent) => this.move(at(event));
    const down = (event: PointerEvent) => this.down(at(event));
    const up = (event: PointerEvent) => {
      this.up(at(event));
      // Touch has no hover: a tap highlights through `selected` alone.
      if (event.pointerType === 'touch') this.move(undefined);
    };
    const leave = () => this.move(undefined);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerdown', down);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointerleave', leave);
    return () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointerleave', leave);
    };
  }

  private emit(event: VectorFeatureEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
