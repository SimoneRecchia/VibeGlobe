/**
 * How the drawing tools show their shapes, through the data layers (`@vibeglobe/layers`): polygons draped on the
 * terrain with their outline, lines draped on the terrain, points clamped to the ground (F364, F365, F351), the
 * in-progress preview, and the edit handles (vertices and edge midpoints).
 */
import type { DataLayer, Feature, GlobeLayers } from '@vibeglobe/layers';
import { toFeature, type DrawnShape, type LonLat } from './geometry.js';

/** Colors of the drawn shapes and of the edit handles' fill (`--vg-ui-drawing-color`, `--vg-ui-drawing-handle-color`). */
export interface DrawColors {
  readonly shape: string;
  readonly handle: string;
}

/** An edit handle: a vertex of a shape, or the midpoint of one of its edges. */
export interface Handle {
  readonly shapeId: string;
  readonly index: number;
  readonly kind: 'vertex' | 'midpoint';
  readonly position: LonLat;
}

/** The layers of one drawing tool. */
export class DrawLayers {
  readonly #layers: GlobeLayers;
  readonly #fills: DataLayer;
  readonly #lines: DataLayer;
  readonly #points: DataLayer;
  readonly #preview: DataLayer;
  readonly #handles: DataLayer;
  #handleCount = 0;

  constructor(
    layers: GlobeLayers,
    module: typeof import('@vibeglobe/layers'),
    prefix: string,
    { shape: COLOR, handle: HANDLE_FILL }: DrawColors,
  ) {
    this.#layers = layers;
    const { stack } = layers;
    this.#fills = stack.add(
      module.polygonLayer({
        id: `${prefix}-fills`,
        style: { 'fill-color': COLOR, 'fill-opacity': 0.25, 'fill-outline-color': COLOR },
      }),
    );
    this.#lines = stack.add(
      module.polylineLayer({ id: `${prefix}-lines`, style: { 'line-color': COLOR, 'line-width': 3 } }),
    );
    this.#preview = stack.add(
      module.polylineLayer({
        id: `${prefix}-preview`,
        style: { 'line-color': COLOR, 'line-width': 2, 'line-opacity': 0.7 },
      }),
    );
    this.#points = stack.add(
      module.pointLayer({
        id: `${prefix}-points`,
        style: {
          'circle-color': COLOR,
          'circle-radius': 6,
          'circle-stroke-color': HANDLE_FILL,
          'circle-stroke-width': 2,
        },
      }),
    );
    this.#handles = stack.add(
      module.pointLayer({
        id: `${prefix}-handles`,
        style: {
          'circle-color': ['case', ['==', ['get', 'midpoint'], 1], COLOR, HANDLE_FILL],
          'circle-radius': ['case', ['==', ['get', 'midpoint'], 1], 4, 6],
          'circle-stroke-color': COLOR,
          'circle-stroke-width': 2,
        },
      }),
    );
  }

  /** Shows a shape, new or changed. */
  show(shape: DrawnShape): void {
    const feature = toFeature(shape);
    if (shape.kind === 'point') return void set(this.#points, shape.id, feature.geometry);
    const ring = feature.geometry.type === 'Polygon' ? feature.geometry.coordinates[0] : undefined;
    if (ring !== undefined) {
      set(this.#fills, shape.id, feature.geometry);
      set(this.#lines, shape.id, { type: 'LineString', coordinates: ring });
    } else set(this.#lines, shape.id, feature.geometry);
  }

  /** Removes a shape. */
  hide(id: string): void {
    for (const layer of [this.#fills, this.#lines, this.#points]) layer.removeFeature(id);
  }

  /** Shows the in-progress line (the placed vertices and the pointer), or nothing. */
  preview(coordinates: readonly LonLat[] | undefined): void {
    if (coordinates === undefined || coordinates.length < 2) this.#preview.removeFeature('preview');
    else set(this.#preview, 'preview', { type: 'LineString', coordinates });
  }

  /** Shows the edit handles, replacing the previous ones. */
  handles(handles: readonly Handle[]): void {
    for (let i = 0; i < this.#handleCount; i++) this.#handles.removeFeature(`h${i}`);
    this.#handleCount = handles.length;
    this.#handles.addFeatures(
      handles.map((handle, i): Feature => ({
        type: 'Feature',
        id: `h${i}`,
        geometry: { type: 'Point', coordinates: [...handle.position] },
        properties: { midpoint: handle.kind === 'midpoint' ? 1 : 0 },
      })),
    );
  }

  /** Removes every layer. */
  destroy(): void {
    for (const layer of [this.#fills, this.#lines, this.#points, this.#preview, this.#handles])
      this.#layers.stack.remove(layer);
  }
}

/** Updates a feature's geometry in place, or adds it. */
function set(layer: DataLayer, id: string, geometry: Feature['geometry']): void {
  if (geometry === null) return;
  if (!layer.updateFeature(id, { geometry })) layer.addFeatures([{ type: 'Feature', id, geometry, properties: {} }]);
}
