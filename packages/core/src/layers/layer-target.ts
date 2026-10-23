/**
 * The draw interface of data layers (ADR 0029, ADR 0037): types and constants only. `@vibeglobe/layers` decides what
 * changed and writes it here; the renderer owns the GPU buffers and draws them.
 */
import type { ModelRenderer } from './models.js';

/** Primitive families a batch can hold. */
export type BatchKind = 'point' | 'marker' | 'label' | 'polyline' | 'polygon' | 'circle';

/**
 * Numeric per-feature attributes of a batch, stored structure-of-arrays (ADR 0029). Components per feature are in
 * {@link ATTRIBUTE_COMPONENTS}: `position` holds longitude and latitude in degrees and height in meters (float64);
 * colors are straight (not premultiplied) RGBA in 0–1; `anchor` is an index into
 * {@link ANCHORS}; `visible` is a visibility factor in 0–1 (0 hidden, 1 shown, between while a label fades); `pickId` is the packed id of picking.ts.
 */
export type BatchAttribute =
  | 'position'
  | 'color'
  | 'outlineColor'
  | 'sizePx'
  | 'widthPx'
  | 'opacity'
  | 'rotationDeg'
  | 'offsetPx'
  | 'heightMeters'
  | 'baseMeters'
  | 'anchor'
  | 'visible'
  | 'pickId';

/** Components per feature of each attribute. */
export const ATTRIBUTE_COMPONENTS: Readonly<Record<BatchAttribute, number>> = {
  position: 3,
  color: 4,
  outlineColor: 4,
  sizePx: 1,
  widthPx: 1,
  opacity: 1,
  rotationDeg: 1,
  offsetPx: 2,
  heightMeters: 1,
  baseMeters: 1,
  anchor: 1,
  visible: 1,
  pickId: 1,
};

/** Anchors of labels and markers (MapLibre `text-anchor` and `icon-anchor`), in the order the `anchor` attribute indexes. */
export const ANCHORS = [
  'center',
  'left',
  'right',
  'top',
  'bottom',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
] as const;

/** Every numeric attribute, in a fixed order (the bit order of the store's dirty flags). */
export const BATCH_ATTRIBUTES = Object.keys(ATTRIBUTE_COMPONENTS) as readonly BatchAttribute[];

/** Per-feature text channels: a label's text and a marker's icon name (the renderer lays out glyphs and atlases icons). */
export type BatchStringChannel = 'text' | 'icon' | 'font';

/** Line and polygon geometry of one feature: flat `[lon, lat, height, ...]` vertices and the start of each part. */
export interface FeatureGeometry {
  readonly positions: Float64Array;
  /** Vertex index where each line or ring starts; polygons list the outer ring first, then holes. */
  readonly partStarts: Uint32Array;
  /** For polygons: index into `partStarts` where each polygon starts (multi-polygons have several). */
  readonly polygonStarts?: Uint32Array;
}

/** How features are placed in height (PLAN.md, Data layers: placement). */
export type Placement = 'clamp-to-ground' | 'drape' | { readonly absoluteAltitudeMeters: number };

/** What the renderer needs to allocate a batch. */
export interface BatchDescriptor {
  readonly kind: BatchKind;
  /** Owning layer id, for diagnostics. */
  readonly layerId: string;
  /** Features the buffers hold before they must grow. */
  readonly capacity: number;
  readonly placement: Placement;
}

/** An opaque handle to a renderer-side batch. */
export interface BatchHandle {
  readonly id: number;
}

/** The draw interface data layers use; every call takes effect on the next frame. */
export interface LayerRenderTarget {
  /** Allocates GPU buffers for a batch. */
  createBatch(descriptor: BatchDescriptor): BatchHandle;
  /** Reallocates a batch for a larger capacity, keeping its contents (not a rebuild: no data is re-uploaded). */
  growBatch(handle: BatchHandle, capacity: number): void;
  /**
   * Uploads features `[first, first + count)` of one attribute; `data` holds the whole attribute array (the renderer
   * reads only the range, so a single-feature change uploads one feature).
   */
  writeRange(
    handle: BatchHandle,
    attribute: BatchAttribute,
    first: number,
    count: number,
    data: Float64Array | Float32Array | Uint32Array,
  ): void;
  /** Uploads text or icon names of features `[first, first + count)`; `values` holds the whole channel. */
  writeStrings(
    handle: BatchHandle,
    channel: BatchStringChannel,
    first: number,
    count: number,
    values: readonly string[],
  ): void;
  /** Sets the line or polygon geometry of one feature (lines and polygons only). */
  writeGeometry(handle: BatchHandle, feature: number, geometry: FeatureGeometry): void;
  /**
   * Overrides an attribute for every feature of the batch with one value (zoom-only style expressions, evaluated once
   * per frame); `undefined` returns to the per-feature values.
   */
  setUniform(handle: BatchHandle, attribute: BatchAttribute, value: Float64Array | undefined): void;
  /** Number of features the renderer draws, from index 0. */
  setCount(handle: BatchHandle, count: number): void;
  /** Draw order of batches: lower first, so higher values draw on top. */
  setOrder(handle: BatchHandle, order: number): void;
  /** Shows or hides the whole batch. */
  setVisible(handle: BatchHandle, visible: boolean): void;
  /** Frees the batch's GPU buffers. */
  release(handle: BatchHandle): void;
  /**
   * Optional: the `pickId` of the topmost feature drawn at a CSS-pixel screen point (nearest within a few pixels), or 0
   * when none is (the layers package's `PickProvider`, F379–F384).
   */
  pick?(point: { readonly xPx: number; readonly yPx: number }): Promise<number>;
  /** The renderer's glTF models, for layers whose features are models (F379, F381). */
  readonly models?: ModelRenderer;
  /**
   * Optional: registers or replaces a marker image by name, which the `icon` channel names (F352): an image, bitmap or
   * canvas the renderer can draw.
   */
  addImage?(name: string, image: unknown): void;
  /**
   * Optional instrumentation (F372, F376, F377): batches rebuilt whole, and feature ranges and vertices uploaded in
   * place, since the target was created.
   */
  stats?(): { readonly rebuilds: number; readonly rangeUploads: number; readonly uploadedVertices: number };
  /** Optional, set by the engine: where clamped and draped features take their heights from (ADR 0037). */
  setGround?(ground: LayerGround): void;
}

/**
 * The terrain under data layers (ADR 0037): the height the frame shows at a position (degrees), and a version that
 * changes when finer terrain arrives, so clamped and draped features are placed again.
 */
export interface LayerGround {
  heightAt(longitudeDeg: number, latitudeDeg: number): number;
  version(): number;
}
