// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The drawing tool's model (F407–F410): its mode, the shapes, the shape being drawn, the edit selection and the events
 * the application receives. Input (`draw-input.ts`) calls its commands with geographic positions; the layers
 * (`draw-layers.ts`) show what it holds.
 */
import {
  MIN_VERTICES,
  ringSelfIntersects,
  toFeature,
  type DrawnFeature,
  type DrawnShape,
  type LonLat,
  type ShapeKind,
} from './geometry.js';
import type { DrawLayers, Handle } from './draw-layers.js';

/** What the tool does with input: nothing, drawing a kind of shape, or editing. */
export type DrawMode = 'none' | ShapeKind | 'edit';

/** The tool's events and their payloads. */
export interface DrawEvents {
  /** A shape was finished. */
  create: { readonly feature: DrawnFeature };
  /** A shape changed (a vertex moved, inserted or deleted, or the shape moved). */
  change: { readonly feature: DrawnFeature };
  /** A shape was deleted. */
  delete: { readonly id: string };
  /** The shape being drawn changed: the placed vertices and the pointer's position, for live readouts. */
  draft: { readonly kind: ShapeKind; readonly coordinates: readonly LonLat[] };
  /** The mode changed. */
  mode: { readonly mode: DrawMode };
  /** Input the tool refused: a polygon that crosses itself (the shape stays as it was, or is not finished). */
  validation: { readonly id: string | undefined; readonly reason: 'self-intersection' };
}

type Handlers = { [E in keyof DrawEvents]: Set<(payload: DrawEvents[E]) => void> };

let shapes = 0;

/** The shapes and the drawing state of one drawing tool. */
export class DrawingTool {
  #mode: DrawMode = 'none';
  readonly #shapes = new Map<string, DrawnShape>();
  #draft: LonLat[] = [];
  #pointer: LonLat | undefined;
  #selected: { shapeId: string; vertex: number | undefined } | undefined;
  #layers: DrawLayers | undefined;
  readonly #handlers: Handlers = {
    create: new Set(),
    change: new Set(),
    delete: new Set(),
    draft: new Set(),
    mode: new Set(),
    validation: new Set(),
  };

  /** Where the tool draws; until it is set, shapes are kept and shown once it is. */
  attach(layers: DrawLayers): void {
    this.#layers = layers;
    for (const shape of this.#shapes.values()) layers.show(shape);
    this.#refresh();
  }

  /** The current mode. */
  get mode(): DrawMode {
    return this.#mode;
  }

  /** The vertices placed so far of the shape being drawn. */
  get draft(): readonly LonLat[] {
    return this.#draft;
  }

  /** The selected shape and vertex in edit mode. */
  get selection(): { readonly shapeId: string; readonly vertex: number | undefined } | undefined {
    return this.#selected;
  }

  /** Every finished shape, as GeoJSON features. */
  features(): DrawnFeature[] {
    return [...this.#shapes.values()].map(toFeature);
  }

  /** A finished shape. */
  shape(id: string): DrawnShape | undefined {
    return this.#shapes.get(id);
  }

  /** Subscribes to an event; returns the unsubscribe function. */
  on<E extends keyof DrawEvents>(event: E, handler: (payload: DrawEvents[E]) => void): () => void {
    const set = this.#handlers[event] as Set<(payload: DrawEvents[E]) => void>;
    set.add(handler);
    return () => set.delete(handler);
  }

  /** Switches the mode; a shape being drawn is dropped. */
  setMode(mode: DrawMode): void {
    this.#draft = [];
    this.#pointer = undefined;
    this.#selected = undefined;
    this.#mode = mode;
    this.#refresh();
    this.#emit('mode', { mode });
  }

  /** Places a vertex of the shape being drawn; a point is finished at once. */
  place(position: LonLat): void {
    const mode = this.#mode;
    if (mode === 'none' || mode === 'edit') return;
    this.#draft = [...this.#draft, position];
    if (mode === 'point') this.finish();
    else this.#updateDraft();
  }

  /** Moves the rubber band of the shape being drawn to the pointer. */
  hover(position: LonLat | undefined): void {
    this.#pointer = position;
    if (this.#draft.length > 0) this.#updateDraft();
  }

  /** Finishes the shape being drawn; false when it has too few vertices or a polygon crosses itself. */
  finish(): boolean {
    const mode = this.#mode;
    if (mode === 'none' || mode === 'edit') return false;
    // A finishing double click or a repeated Enter placed the last vertex twice.
    const vertices = this.#draft.filter((p, i, all) => i === 0 || !same(p, all[i - 1]));
    if (mode === 'polygon' && vertices.length > 3 && same(vertices[0], vertices.at(-1))) vertices.pop();
    if (vertices.length < MIN_VERTICES[mode]) return false;
    if (mode === 'polygon' && ringSelfIntersects(vertices)) {
      this.#emit('validation', { id: undefined, reason: 'self-intersection' });
      return false;
    }
    const shape: DrawnShape = { id: `shape-${++shapes}`, kind: mode, coordinates: vertices };
    this.#shapes.set(shape.id, shape);
    this.#draft = [];
    this.#layers?.show(shape);
    this.#refresh();
    this.#emit('create', { feature: toFeature(shape) });
    return true;
  }

  /**
   * Adds a finished shape, such as one saved earlier, without a `create` event (F660); returns its id, or undefined
   * when it has too few vertices or a polygon crosses itself.
   */
  addShape(kind: ShapeKind, coordinates: readonly LonLat[]): string | undefined {
    if (coordinates.length < MIN_VERTICES[kind] || (kind === 'polygon' && ringSelfIntersects(coordinates)))
      return undefined;
    const shape: DrawnShape = { id: `shape-${++shapes}`, kind, coordinates: [...coordinates] };
    this.#shapes.set(shape.id, shape);
    this.#layers?.show(shape);
    this.#refresh();
    return shape.id;
  }

  /** Drops the shape being drawn, or the edit selection. */
  cancel(): void {
    this.#draft = [];
    this.#selected = undefined;
    this.#refresh();
  }

  /** Selects a shape (and one of its vertices) for editing. */
  select(shapeId: string | undefined, vertex?: number): void {
    this.#selected = shapeId === undefined || !this.#shapes.has(shapeId) ? undefined : { shapeId, vertex };
    this.#refresh();
  }

  /** Moves a vertex of a shape; false when it would make a polygon cross itself. */
  moveVertex(shapeId: string, index: number, position: LonLat): boolean {
    const shape = this.#shapes.get(shapeId);
    if (shape === undefined || index < 0 || index >= shape.coordinates.length) return false;
    const coordinates = shape.coordinates.map((p, i) => (i === index ? position : p));
    return this.#replace(shape, coordinates);
  }

  /** Inserts a vertex after vertex `index` of a line or polygon. */
  insertVertex(shapeId: string, index: number, position: LonLat): boolean {
    const shape = this.#shapes.get(shapeId);
    if (shape === undefined || shape.kind === 'point') return false;
    const coordinates = [...shape.coordinates];
    coordinates.splice(index + 1, 0, position);
    const done = this.#replace(shape, coordinates);
    if (done) this.#selected = { shapeId, vertex: index + 1 };
    this.#refresh();
    return done;
  }

  /** Deletes a vertex, keeping the shape's minimum; a point's only vertex deletes the point. */
  deleteVertex(shapeId: string, index: number): boolean {
    const shape = this.#shapes.get(shapeId);
    if (shape === undefined) return false;
    if (shape.kind === 'point') return this.deleteShape(shapeId);
    if (shape.coordinates.length <= MIN_VERTICES[shape.kind]) return false;
    const done = this.#replace(
      shape,
      shape.coordinates.filter((_, i) => i !== index),
    );
    if (done) this.#selected = { shapeId, vertex: undefined };
    this.#refresh();
    return done;
  }

  /** Moves a whole shape by a longitude and latitude offset. */
  moveShape(shapeId: string, deltaLonDeg: number, deltaLatDeg: number): boolean {
    const shape = this.#shapes.get(shapeId);
    if (shape === undefined) return false;
    return this.#replace(
      shape,
      shape.coordinates.map(([lon, lat]): LonLat => [
        lon + deltaLonDeg,
        Math.max(-90, Math.min(90, lat + deltaLatDeg)),
      ]),
    );
  }

  /** Deletes a shape. */
  deleteShape(shapeId: string): boolean {
    if (!this.#shapes.delete(shapeId)) return false;
    this.#layers?.hide(shapeId);
    if (this.#selected?.shapeId === shapeId) this.#selected = undefined;
    this.#refresh();
    this.#emit('delete', { id: shapeId });
    return true;
  }

  /** Deletes the selected vertex, or the selected shape when no vertex is selected. */
  deleteSelection(): boolean {
    const selected = this.#selected;
    if (selected === undefined) return false;
    return selected.vertex === undefined
      ? this.deleteShape(selected.shapeId)
      : this.deleteVertex(selected.shapeId, selected.vertex);
  }

  /** The edit handles of the selected shape: its vertices and, for lines and polygons, its edge midpoints. */
  handles(): Handle[] {
    const selected = this.#selected;
    const shape = selected === undefined ? undefined : this.#shapes.get(selected.shapeId);
    if (shape === undefined || this.#mode !== 'edit') return [];
    const vertices: Handle[] = shape.coordinates.map((position, index) => ({
      shapeId: shape.id,
      index,
      kind: 'vertex',
      position,
    }));
    if (shape.kind === 'point') return vertices;
    const n = shape.coordinates.length;
    const edges = shape.kind === 'polygon' ? n : n - 1;
    for (let index = 0; index < edges; index++) {
      const a = shape.coordinates[index];
      const b = shape.coordinates[(index + 1) % n];
      if (a && b) vertices.push({ shapeId: shape.id, index, kind: 'midpoint', position: midpoint(a, b) });
    }
    return vertices;
  }

  /** Removes the layers; the shapes stay in the model. */
  detach(): void {
    this.#layers?.destroy();
    this.#layers = undefined;
  }

  #replace(shape: DrawnShape, coordinates: readonly LonLat[]): boolean {
    if (shape.kind === 'polygon' && ringSelfIntersects(coordinates)) {
      this.#emit('validation', { id: shape.id, reason: 'self-intersection' });
      return false;
    }
    const next: DrawnShape = { ...shape, coordinates };
    this.#shapes.set(shape.id, next);
    this.#layers?.show(next);
    this.#refresh();
    this.#emit('change', { feature: toFeature(next) });
    return true;
  }

  #updateDraft(): void {
    const mode = this.#mode;
    if (mode === 'none' || mode === 'edit' || mode === 'point') return;
    const coordinates = this.#pointer === undefined ? this.#draft : [...this.#draft, this.#pointer];
    const shown =
      mode === 'polygon' && coordinates.length > 2 ? [...coordinates, coordinates[0] as LonLat] : coordinates;
    this.#layers?.preview(shown);
    this.#emit('draft', { kind: mode, coordinates });
  }

  #refresh(): void {
    this.#layers?.handles(this.handles());
    if (this.#draft.length === 0) this.#layers?.preview(undefined);
    else this.#updateDraft();
  }

  #emit<E extends keyof DrawEvents>(event: E, payload: DrawEvents[E]): void {
    for (const handler of [...(this.#handlers[event] as Set<(payload: DrawEvents[E]) => void>)]) handler(payload);
  }
}

function same(a: LonLat | undefined, b: LonLat | undefined): boolean {
  return a !== undefined && b !== undefined && Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

/** The midpoint of an edge, longitudes taken the short way round. */
function midpoint(a: LonLat, b: LonLat): LonLat {
  const delta = ((b[0] - a[0] + 540) % 360) - 180;
  const lon = a[0] + delta / 2;
  return [((lon + 540) % 360) - 180, (a[1] + b[1]) / 2];
}
