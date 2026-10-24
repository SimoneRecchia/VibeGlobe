// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Paint of vector tile meshes (F440, F446, F450; ADR 0131): each feature's paint evaluated at the two integer zooms
 * around the camera's, so the renderer mixes them continuously, and written per vertex. Colors stay sRGB, as the style
 * specification interpolates them; the renderer converts to linear light after mixing. A paint change or a
 * feature-state change rewrites these arrays in place; the geometry stays (no new layout, no new download).
 */
import type { Bucket, BucketFeature } from './layout-tile.js';
import type { FeatureStateMap, StyleColor, StyleLayer } from './style-layer.js';
import type { VectorMeshKind } from './vector-target.js';

/** The paint arrays of one mesh. */
export interface MeshPaint {
  readonly colorA: Float32Array;
  readonly colorB: Float32Array;
  readonly paramsA: Float32Array;
  readonly paramsB: Float32Array;
  readonly stroke?: Float32Array;
}

/** A second mesh of a style layer: a fill's outline (`fill-outline-color`, F445). */
export type PaintPart = 'outline';

/** A sprite image packed in the target's atlas, for `fill-pattern`: texels, and its pixel ratio. */
export interface PatternRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
}

/** What paint needs besides the layer: the mesh's part, sprite patterns, and per-vertex line progress. */
export interface PaintOptions {
  readonly part?: PaintPart | undefined;
  readonly pattern?: ((name: string) => PatternRect | undefined) | undefined;
  /** `line-progress` (0–1) per vertex, for `line-gradient`. */
  readonly progress?: Float32Array | undefined;
}

/** The mesh kind that draws a style layer type (or a bucket type: `fill-outline`), if any. */
export function meshKindOf(type: string): VectorMeshKind | undefined {
  if (type === 'fill' || type === 'line' || type === 'circle') return type;
  if (type === 'fill-outline') return 'line';
  if (type === 'background') return 'fill';
  if (type === 'fill-extrusion') return 'extrusion';
  return undefined;
}

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** A style color as straight sRGB RGBA with an opacity factor; transparent when missing. */
function srgbColor(value: unknown, opacity = 1): [number, number, number, number] {
  const c = value as StyleColor | undefined;
  if (c === undefined || typeof c.r !== 'number') return [0, 0, 0, 0];
  return [c.r, c.g, c.b, c.a * opacity];
}

/** A style color (straight sRGB) as straight linear RGBA with an opacity factor; transparent when missing. */
export function linearColor(value: unknown, opacity = 1): [number, number, number, number] {
  const c = value as StyleColor | undefined;
  if (c === undefined || typeof c.r !== 'number') return [0, 0, 0, 0];
  return [toLinear(c.r), toLinear(c.g), toLinear(c.b), c.a * opacity];
}

const num = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

type FeatureState = (feature: BucketFeature) => FeatureStateMap | undefined;

/** One feature's color and parameters at a zoom. */
function featurePaint(
  layer: StyleLayer,
  zoom: number,
  feature: BucketFeature,
  state: FeatureStateMap | undefined,
  options: PaintOptions,
): { color: number[]; params: number[]; stroke?: number[] } {
  const p = (name: string) => layer.paint(name, zoom, feature, state);
  switch (layer.type) {
    case 'fill': {
      const opacity = num(p('fill-opacity'), 1);
      // The outline: about one pixel (two wide, so it always covers a row of pixels), in the outline color.
      if (options.part === 'outline')
        return { color: srgbColor(p('fill-outline-color') ?? p('fill-color'), opacity), params: [1, 0, 0, 0] };
      const name = p('fill-pattern');
      const pattern = typeof name === 'string' && name !== '' ? options.pattern?.(name) : undefined;
      // A pattern: its atlas texels in the parameters; its pixel ratio and a flag (green −1) in the color (F445).
      if (pattern !== undefined)
        return {
          color: [pattern.pixelRatio, -1, 0, opacity],
          params: [pattern.x, pattern.y, pattern.width, pattern.height],
        };
      return { color: srgbColor(p('fill-color'), opacity), params: [0, 0, 0, 0] };
    }
    case 'line': {
      const width = num(p('line-width'), 1);
      const gap = num(p('line-gap-width'));
      // With a gap, two lines of `width` border it (casings); otherwise one line centered on the path.
      const params = gap > 0 ? [width, num(p('line-blur')), gap / 2, 0] : [width / 2, num(p('line-blur')), 0, 0];
      return { color: srgbColor(p('line-color'), num(p('line-opacity'), 1)), params };
    }
    case 'fill-extrusion':
      return { color: srgbColor(p('fill-extrusion-color'), 1), params: [0, 0, 0, 0] };
    case 'background':
      return { color: srgbColor(p('background-color'), num(p('background-opacity'), 1)), params: [0, 0, 0, 0] };
    case 'circle': {
      const opacity = num(p('circle-opacity'), 1);
      return {
        color: srgbColor(p('circle-color'), opacity),
        params: [num(p('circle-radius'), 5), num(p('circle-blur')), num(p('circle-stroke-width')), 0],
        stroke: srgbColor(p('circle-stroke-color'), num(p('circle-stroke-opacity'), 1) * opacity),
      };
    }
    default:
      return { color: [0, 0, 0, 0], params: [0, 0, 0, 0] };
  }
}

/**
 * Writes the paint of every vertex at zooms `zoomA` and `zoomB` (A + 1). `featureIndex` maps vertices to features;
 * circles have four vertices per feature anchor, which the index already says.
 */
export function meshPaint(
  layer: StyleLayer,
  bucket: Pick<Bucket, 'features'>,
  featureIndex: Uint32Array,
  zoomA: number,
  state: FeatureState,
  into?: MeshPaint,
  options: PaintOptions = {},
): MeshPaint {
  const n = featureIndex.length;
  const out: MeshPaint = into ?? {
    colorA: new Float32Array(n * 4),
    colorB: new Float32Array(n * 4),
    paramsA: new Float32Array(n * 4),
    paramsB: new Float32Array(n * 4),
    ...(layer.type === 'circle' ? { stroke: new Float32Array(n * 4) } : {}),
  };
  const perFeature = bucket.features.map((feature) => {
    const s = state(feature);
    return [
      featurePaint(layer, zoomA, feature, s, options),
      featurePaint(layer, zoomA + 1, feature, s, options),
    ] as const;
  });
  for (let v = 0; v < n; v++) {
    const pair = perFeature[featureIndex[v] ?? 0];
    if (pair === undefined) continue;
    const [a, b] = pair;
    out.colorA.set(a.color, v * 4);
    out.colorB.set(b.color, v * 4);
    out.paramsA.set(a.params, v * 4);
    out.paramsB.set(b.params, v * 4);
    if (out.stroke !== undefined && a.stroke !== undefined) out.stroke.set(a.stroke, v * 4);
  }
  if (layer.type === 'line' && options.progress !== undefined && layer.json.paint?.['line-gradient'] !== undefined)
    lineGradient(layer, zoomA, options.progress, out);
  return out;
}

/** Colors of a `line-gradient` at each vertex's `line-progress` (both zooms; the line's opacity kept). */
function lineGradient(layer: StyleLayer, zoomA: number, progress: Float32Array, out: MeshPaint): void {
  const ramp = Array.from({ length: 256 }, (_, i) =>
    srgbColor(layer.paint('line-gradient', zoomA, undefined, undefined, { lineProgress: i / 255 })),
  );
  for (let v = 0; v < progress.length; v++) {
    const c = ramp[Math.round(Math.min(1, Math.max(0, progress[v] ?? 0)) * 255)] ?? [0, 0, 0, 0];
    for (const colors of [out.colorA, out.colorB]) {
      const opacity = colors[v * 4 + 3] ?? 1;
      colors.set([c[0], c[1], c[2], c[3] * opacity], v * 4);
    }
  }
}

/** The zoom pair and mixing factor of a camera zoom: A = ⌊zoom⌋, t = zoom − A. */
export function zoomBracket(zoom: number): { zoomA: number; t: number } {
  const zoomA = Math.floor(zoom);
  return { zoomA, t: zoom - zoomA };
}
