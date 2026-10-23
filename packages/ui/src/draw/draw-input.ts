/**
 * Mouse, touch and keyboard input of the drawing tools (F407–F410). Pointer listeners sit on the map container in the
 * capture phase, ahead of the navigation controls: a tap places a vertex and lets the press through (a tap neither pans
 * nor zooms), the second tap of a double tap finishes and is kept from the controls (so it never zooms), and a press on
 * an edit handle or a selected shape is kept from them (so editing never pans). Dragging elsewhere still pans the map.
 * The keyboard drives a cursor over the map: arrows move it, Enter places or picks, Delete deletes, Escape cancels.
 */
import type { Globe } from '@vibeglobe/core';
import { insideRing, segmentDistanceSquared, type LonLat, type ScreenXY } from './geometry.js';
import type { DrawingTool } from './drawing-tool.js';
import type { Handle } from './draw-layers.js';

/** A press and release within this distance is a tap, CSS pixels. */
const TAP_SLOP_PX = 6;
/** Two taps within this time and distance are a double tap. */
const DOUBLE_TAP_MS = 400;
const DOUBLE_TAP_PX = 12;
/** How near a handle or a line a press must land, CSS pixels. */
const HIT_PX = 12;
/** Keyboard cursor steps, CSS pixels: an arrow, and Shift with an arrow. */
const KEY_STEP_PX = 8;
const KEY_STEP_FAST_PX = 40;

/** What a press in edit mode grabbed. */
type Grab =
  | { readonly kind: 'vertex'; readonly shapeId: string; readonly index: number }
  | { readonly kind: 'shape'; readonly shapeId: string; readonly from: LonLat };

/** Connects a drawing tool to the map container's pointer events and to a keyboard cursor. */
export class DrawInput {
  readonly #globe: Globe;
  readonly #container: HTMLElement;
  readonly #tool: DrawingTool;
  readonly #cursor: HTMLElement;
  readonly #stops: (() => void)[] = [];
  #press: { id: number; x: number; y: number } | undefined;
  #lastTap: { timeMs: number; x: number; y: number } | undefined;
  #swallowed: number | undefined;
  #grab: { pointerId: number; grab: Grab } | undefined;
  #cursorAt: ScreenXY;
  #announce: (position: LonLat | undefined) => void;

  /**
   * @param cursor - The keyboard cursor element, positioned over the map by this class.
   * @param announce - Called with the cursor's position after each keyboard move (accessible name, readouts).
   */
  constructor(
    globe: Globe,
    container: HTMLElement,
    tool: DrawingTool,
    cursor: HTMLElement,
    announce: (position: LonLat | undefined) => void,
  ) {
    this.#globe = globe;
    this.#container = container;
    this.#tool = tool;
    this.#cursor = cursor;
    this.#announce = announce;
    this.#cursorAt = { xPx: container.clientWidth / 2, yPx: container.clientHeight / 2 };
    this.#listen('pointerdown', (event) => this.#onDown(event as PointerEvent));
    this.#listen('pointermove', (event) => this.#onMove(event as PointerEvent));
    this.#listen('pointerup', (event) => this.#onUp(event as PointerEvent));
    this.#listen('pointercancel', () => (this.#grab = this.#press = undefined));
    this.#listen('dblclick', (event) => {
      if (this.#tool.mode === 'none') return;
      event.stopPropagation();
      event.preventDefault();
    });
    cursor.addEventListener('keydown', this.#onKey);
    this.#stops.push(() => cursor.removeEventListener('keydown', this.#onKey));
    this.#placeCursor();
  }

  /** Puts the keyboard cursor at the center of the map. */
  resetCursor(): void {
    this.#cursorAt = { xPx: this.#container.clientWidth / 2, yPx: this.#container.clientHeight / 2 };
    this.#placeCursor();
  }

  /** The geographic position under the keyboard cursor. */
  cursorPosition(): LonLat | undefined {
    return this.#geo(this.#cursorAt);
  }

  /** Removes the listeners. */
  destroy(): void {
    for (const stop of this.#stops) stop();
    this.#stops.length = 0;
  }

  #listen(type: string, listener: (event: Event) => void): void {
    this.#container.addEventListener(type, listener, { capture: true });
    this.#stops.push(() => this.#container.removeEventListener(type, listener, { capture: true }));
  }

  #local(event: MouseEvent): ScreenXY {
    const box = this.#container.getBoundingClientRect();
    return { xPx: event.clientX - box.left, yPx: event.clientY - box.top };
  }

  #geo(point: ScreenXY): LonLat | undefined {
    const position = this.#globe.screenToGeo(point);
    return position === undefined ? undefined : [position.longitudeDeg, position.latitudeDeg];
  }

  /** Input on the UI's own controls is theirs. */
  #onControls(event: Event): boolean {
    return event.target instanceof Element && event.target.closest('.vg-ui__control, .vg-ui__draw-cursor') !== null;
  }

  #onDown(event: PointerEvent): void {
    const mode = this.#tool.mode;
    if (mode === 'none' || this.#onControls(event) || !event.isPrimary || event.button !== 0) return;
    const at = this.#local(event);
    if (mode === 'edit') return this.#editDown(event, at);
    const last = this.#lastTap;
    if (
      last !== undefined &&
      event.timeStamp - last.timeMs < DOUBLE_TAP_MS &&
      Math.hypot(at.xPx - last.x, at.yPx - last.y) < DOUBLE_TAP_PX
    ) {
      // The second tap of a double tap: it finishes the shape, and the controls never see it (no zoom).
      this.#swallowed = event.pointerId;
      this.#lastTap = undefined;
      event.stopPropagation();
      event.preventDefault();
      return;
    }
    this.#press = { id: event.pointerId, x: at.xPx, y: at.yPx };
  }

  #onMove(event: PointerEvent): void {
    const mode = this.#tool.mode;
    if (mode === 'none') return;
    const at = this.#local(event);
    const grabbed = this.#grab;
    if (grabbed !== undefined && grabbed.pointerId === event.pointerId) {
      event.stopPropagation();
      this.#drag(grabbed.grab, at);
      return;
    }
    if (this.#swallowed === event.pointerId) event.stopPropagation();
    if (mode !== 'edit' && !this.#onControls(event)) this.#tool.hover(this.#geo(at));
  }

  #onUp(event: PointerEvent): void {
    if (this.#swallowed === event.pointerId) {
      this.#swallowed = undefined;
      event.stopPropagation();
      if (this.#tool.mode === 'point') {
        const position = this.#geo(this.#local(event));
        if (position !== undefined) this.#tool.place(position);
      } else this.#tool.finish();
      return;
    }
    if (this.#grab?.pointerId === event.pointerId) {
      this.#grab = undefined;
      if (this.#container.hasPointerCapture(event.pointerId)) this.#container.releasePointerCapture(event.pointerId);
      event.stopPropagation();
      return;
    }
    const press = this.#press;
    this.#press = undefined;
    if (press === undefined || press.id !== event.pointerId) return;
    const at = this.#local(event);
    if (Math.hypot(at.xPx - press.x, at.yPx - press.y) > TAP_SLOP_PX) return;
    const position = this.#geo(at);
    if (position === undefined) return;
    this.#lastTap = { timeMs: event.timeStamp, x: at.xPx, y: at.yPx };
    this.#placeAt(at, position);
  }

  /** Places a vertex, or finishes a polygon when the point is on its first vertex. */
  #placeAt(at: ScreenXY, position: LonLat): void {
    const draft = this.#tool.draft;
    const first = draft[0] === undefined ? undefined : this.#screen(draft[0]);
    if (
      this.#tool.mode === 'polygon' &&
      draft.length >= 3 &&
      first !== undefined &&
      Math.hypot(first.xPx - at.xPx, first.yPx - at.yPx) <= HIT_PX
    )
      this.#tool.finish();
    else this.#tool.place(position);
  }

  /** A press in edit mode: a handle or a shape grabs it from the controls; elsewhere it deselects and pans. */
  #editDown(event: PointerEvent, at: ScreenXY): void {
    const grab = this.#hit(at);
    if (grab === undefined) {
      this.#tool.select(undefined);
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    this.#grab = { pointerId: event.pointerId, grab };
    this.#container.setPointerCapture(event.pointerId);
  }

  /** What lies under a screen point in edit mode: a handle of the selected shape first, then any shape. */
  #hit(at: ScreenXY): Grab | undefined {
    const near = (handle: Handle): boolean => {
      const point = this.#screen(handle.position);
      return point !== undefined && Math.hypot(point.xPx - at.xPx, point.yPx - at.yPx) <= HIT_PX;
    };
    const handle = this.#tool.handles().find(near);
    if (handle?.kind === 'vertex') {
      this.#tool.select(handle.shapeId, handle.index);
      return { kind: 'vertex', shapeId: handle.shapeId, index: handle.index };
    }
    if (handle?.kind === 'midpoint') {
      this.#tool.insertVertex(handle.shapeId, handle.index, handle.position);
      return { kind: 'vertex', shapeId: handle.shapeId, index: handle.index + 1 };
    }
    // A vertex of any shape: selects that shape and vertex.
    for (const feature of this.#tool.features().reverse()) {
      const index = this.#tool.shape(feature.id)?.coordinates.findIndex((p) => {
        const point = this.#screen(p);
        return point !== undefined && Math.hypot(point.xPx - at.xPx, point.yPx - at.yPx) <= HIT_PX;
      });
      if (index === undefined || index < 0) continue;
      this.#tool.select(feature.id, index);
      return { kind: 'vertex', shapeId: feature.id, index };
    }
    const shapeId = this.#shapeAt(at);
    const from = this.#geo(at);
    if (shapeId === undefined || from === undefined) return undefined;
    this.#tool.select(shapeId);
    return { kind: 'shape', shapeId, from };
  }

  /** The topmost shape under a screen point: near a point or a line, or inside a polygon. */
  #shapeAt(at: ScreenXY): string | undefined {
    const shapes = this.#tool.features().reverse();
    for (const feature of shapes) {
      const shape = this.#tool.shape(feature.id);
      if (shape === undefined) continue;
      const points = shape.coordinates.map((p) => this.#screen(p));
      if (points.some((p) => p === undefined)) continue;
      const screen = points as ScreenXY[];
      if (shape.kind === 'polygon' && insideRing(at, screen)) return shape.id;
      const ring = shape.kind === 'polygon' ? [...screen, screen[0] as ScreenXY] : screen;
      if (shape.kind === 'point' && screen[0] && Math.hypot(screen[0].xPx - at.xPx, screen[0].yPx - at.yPx) <= HIT_PX)
        return shape.id;
      for (let i = 1; i < ring.length; i++) {
        const a = ring[i - 1];
        const b = ring[i];
        if (a && b && segmentDistanceSquared(at, a, b) <= HIT_PX * HIT_PX) return shape.id;
      }
    }
    return undefined;
  }

  #drag(grab: Grab, at: ScreenXY): void {
    const position = this.#geo(at);
    if (position === undefined) return;
    if (grab.kind === 'vertex') this.#tool.moveVertex(grab.shapeId, grab.index, position);
    else if (this.#tool.moveShape(grab.shapeId, position[0] - grab.from[0], position[1] - grab.from[1]))
      this.#grab = this.#grab && { ...this.#grab, grab: { ...grab, from: position } };
  }

  #screen(position: LonLat): ScreenXY | undefined {
    return this.#globe.geoToScreen({ longitudeDeg: position[0], latitudeDeg: position[1] });
  }

  readonly #onKey = (event: KeyboardEvent): void => {
    const step = event.shiftKey ? KEY_STEP_FAST_PX : KEY_STEP_PX;
    const moves: Readonly<Record<string, readonly [number, number]>> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (move !== undefined) this.#keyMove(move[0], move[1]);
    else if (event.key === 'Enter' || event.key === ' ') this.#keyConfirm();
    else if (event.key === 'Delete' || event.key === 'Backspace') this.#tool.deleteSelection();
    else if (event.key === 'Escape') this.#tool.cancel();
    else return;
    // Handled here: the navigation controls' keys (arrows pan the map) must not see it.
    event.preventDefault();
    event.stopPropagation();
  };

  /** An arrow: moves the selected vertex or shape in edit mode, else the cursor. */
  #keyMove(dx: number, dy: number): void {
    const from = this.#geo(this.#cursorAt);
    this.#cursorAt = {
      xPx: Math.min(this.#container.clientWidth, Math.max(0, this.#cursorAt.xPx + dx)),
      yPx: Math.min(this.#container.clientHeight, Math.max(0, this.#cursorAt.yPx + dy)),
    };
    this.#placeCursor();
    const to = this.#geo(this.#cursorAt);
    const selected = this.#tool.selection;
    if (this.#tool.mode === 'edit' && selected !== undefined && from !== undefined && to !== undefined) {
      if (selected.vertex !== undefined) this.#tool.moveVertex(selected.shapeId, selected.vertex, to);
      else this.#tool.moveShape(selected.shapeId, to[0] - from[0], to[1] - from[1]);
    } else if (this.#tool.mode !== 'edit') this.#tool.hover(to);
  }

  /** Enter: places a vertex (again at the last one: finishes), or in edit mode picks what is under the cursor. */
  #keyConfirm(): void {
    const position = this.#geo(this.#cursorAt);
    if (position === undefined) return;
    if (this.#tool.mode === 'edit') {
      const grab = this.#hit(this.#cursorAt);
      if (grab === undefined) this.#tool.select(undefined);
      return;
    }
    const last = this.#tool.draft.at(-1);
    const point = last === undefined ? undefined : this.#screen(last);
    if (point !== undefined && Math.hypot(point.xPx - this.#cursorAt.xPx, point.yPx - this.#cursorAt.yPx) < 1)
      this.#tool.finish();
    else this.#placeAt(this.#cursorAt, position);
  }

  #placeCursor(): void {
    this.#cursor.style.left = `${this.#cursorAt.xPx}px`;
    this.#cursor.style.top = `${this.#cursorAt.yPx}px`;
    this.#announce(this.#geo(this.#cursorAt));
  }
}
