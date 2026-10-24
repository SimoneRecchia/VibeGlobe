// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Data-driven and zoom-dependent styles (F369, F370) with MapLibre Style Specification semantics, evaluated by the
 * specification's own expression engine (`@maplibre/maplibre-gl-style-spec`, ISC; ADR 0029). A style maps MapLibre
 * paint and layout property names to values or expressions; each property feeds one batch attribute.
 */
import {
  Color,
  createPropertyExpression,
  isExpression,
  latest,
  type StylePropertySpecification,
} from '@maplibre/maplibre-gl-style-spec';
import { ANCHORS, type BatchAttribute, type BatchKind, type BatchStringChannel } from './render-target.js';

/** A layer style: MapLibre property names to constants or expressions, for example `{ 'circle-color': ['get', 'c'] }`. */
export type LayerStyle = Readonly<Record<string, unknown>>;

/** Where a style property's value goes; `sortKey` is read by label placement and not uploaded. */
export type StyleChannel = BatchAttribute | BatchStringChannel | 'sortKey';

/** A feature as the expressions see it. */
export interface StyleFeature {
  readonly id?: string | number | undefined;
  /** GeoJSON geometry type, for `['geometry-type']`. */
  readonly type: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

/** Thrown when a style is malformed: an unknown property for the layer kind or an invalid expression. */
export class StyleError extends Error {
  override readonly name = 'StyleError';
  /** One message per problem, each prefixed with the property name. */
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid layer style: ${problems.join('; ')}`);
    this.problems = problems;
  }
}

/** The MapLibre property groups each kind reads and the attribute each property feeds. */
const KIND_PROPERTIES: Readonly<Record<BatchKind, { groups: readonly string[]; map: Record<string, StyleChannel> }>> = {
  point: {
    groups: ['paint_circle'],
    map: {
      'circle-color': 'color',
      'circle-radius': 'sizePx',
      'circle-opacity': 'opacity',
      'circle-stroke-color': 'outlineColor',
      'circle-stroke-width': 'widthPx',
    },
  },
  marker: {
    groups: ['layout_symbol', 'paint_symbol'],
    map: {
      'icon-image': 'icon',
      'icon-size': 'sizePx',
      'icon-rotate': 'rotationDeg',
      'icon-offset': 'offsetPx',
      'icon-anchor': 'anchor',
      'icon-opacity': 'opacity',
      'icon-color': 'color',
    },
  },
  label: {
    groups: ['layout_symbol', 'paint_symbol'],
    map: {
      'text-field': 'text',
      'text-font': 'font',
      'text-size': 'sizePx',
      'text-rotate': 'rotationDeg',
      'text-offset': 'offsetPx',
      'text-anchor': 'anchor',
      'symbol-sort-key': 'sortKey',
      'text-color': 'color',
      'text-halo-color': 'outlineColor',
      'text-halo-width': 'widthPx',
      'text-opacity': 'opacity',
    },
  },
  polyline: {
    groups: ['paint_line'],
    map: { 'line-color': 'color', 'line-width': 'widthPx', 'line-opacity': 'opacity' },
  },
  polygon: {
    groups: ['paint_fill', 'paint_fill-extrusion'],
    map: {
      'fill-color': 'color',
      'fill-opacity': 'opacity',
      'fill-outline-color': 'outlineColor',
      'fill-extrusion-height': 'heightMeters',
      'fill-extrusion-base': 'baseMeters',
    },
  },
  circle: {
    groups: ['paint_fill'],
    map: { 'fill-color': 'color', 'fill-opacity': 'opacity', 'fill-outline-color': 'outlineColor' },
  },
};

/**
 * A compiled expression, as far as the layers use it (the style specification's own types stay out of this package's
 * declarations, which would otherwise need the global GeoJSON types).
 */
export interface StyleExpression {
  /** 'constant', 'source' (per feature), 'camera' (per zoom) or 'composite' (per feature and zoom). */
  readonly kind: 'constant' | 'source' | 'camera' | 'composite';
  evaluate(globals: { zoom: number }, feature?: unknown, featureState?: unknown): unknown;
}

/** One compiled property. */
export interface CompiledProperty {
  readonly name: string;
  readonly channel: StyleChannel;
  /** 'constant', 'source' (per feature), 'camera' (per zoom) or 'composite' (per feature and zoom). */
  readonly kind: StyleExpression['kind'];
  readonly expression: StyleExpression;
}

/** A compiled style: every property the kind reads, with the specification's defaults for unset ones. */
export interface CompiledStyle {
  readonly properties: readonly CompiledProperty[];
  /** True when some property depends on the zoom (re-evaluated when the zoom changes). */
  readonly zoomDependent: boolean;
}

function propertySpec(groups: readonly string[], name: string): StylePropertySpecification | undefined {
  const reference = latest as unknown as Record<string, Record<string, StylePropertySpecification> | undefined>;
  for (const group of groups) {
    const spec = reference[group]?.[name];
    if (spec !== undefined) return spec;
  }
  return undefined;
}

/**
 * Validates and compiles a style for a layer kind.
 * @throws StyleError listing every unknown property and malformed expression.
 */
export function compileStyle(kind: BatchKind, style: LayerStyle = {}): CompiledStyle {
  const { groups, map } = KIND_PROPERTIES[kind];
  const problems: string[] = [];
  for (const name of Object.keys(style)) {
    if (!(name in map))
      problems.push(`${name}: not a property of ${kind} layers (expected one of ${Object.keys(map).join(', ')})`);
  }
  const properties: CompiledProperty[] = [];
  for (const [name, channel] of Object.entries(map)) {
    const spec = propertySpec(groups, name);
    if (spec === undefined) throw new Error(`style specification has no ${name}`);
    const value = style[name] ?? (spec as { default?: unknown }).default;
    if (value === undefined) continue;
    // A constant array (`[0, 1]` for an offset, a font stack) is a literal, not an expression (MapLibre semantics).
    const input = Array.isArray(value) && !isExpression(value) ? ['literal', value] : value;
    let compiled: ReturnType<typeof createPropertyExpression>;
    try {
      compiled = createPropertyExpression(input, name, spec);
    } catch (error) {
      // Malformed input the style-spec throws on (an operator named "__proto__", TG-03) is a style problem.
      problems.push(`${name}: invalid expression (${error instanceof Error ? error.message : String(error)})`);
      continue;
    }
    if (compiled.result === 'error') {
      for (const error of compiled.value) problems.push(`${name}${error.key}: ${error.message}`);
      continue;
    }
    const expression = compiled.value as unknown as StyleExpression;
    properties.push({ name, channel, kind: expression.kind, expression });
  }
  if (problems.length > 0) throw new StyleError(problems);
  return {
    properties,
    zoomDependent: properties.some((p) => p.kind === 'camera' || p.kind === 'composite'),
  };
}

/** Whether a channel holds a string per feature (text, marker image name, font stack) rather than numbers. */
export function isStringChannel(channel: string): channel is 'text' | 'icon' | 'font' {
  return channel === 'text' || channel === 'icon' || channel === 'font';
}

/**
 * Evaluates one property and writes its numeric value into `out` at `offset` (colors as straight RGBA, offsets as two
 * numbers, everything else one number).
 * @returns the string value for the text, icon and font channels, otherwise undefined.
 */
export function evaluateProperty(
  property: CompiledProperty,
  zoom: number,
  feature: StyleFeature | undefined,
  out: Float64Array,
  offset: number,
  featureState?: Readonly<Record<string, unknown>>,
): string | undefined {
  const value = property.expression.evaluate({ zoom }, feature, featureState);
  if (isStringChannel(property.channel)) {
    if (value === undefined || value === null) return '';
    // A font stack (`text-font`) is a list of family names: a CSS font-family list.
    // Names are quoted, except single-word ones such as the generic families (`serif`, `monospace`).
    if (Array.isArray(value))
      return value
        .map((name) => (/^[a-z-]+$/i.test(String(name)) ? String(name) : JSON.stringify(String(name))))
        .join(', ');
    const named = value as { name?: unknown };
    return typeof named.name === 'string' ? named.name : String(value);
  }
  if (property.channel === 'anchor') {
    out[offset] = Math.max(0, ANCHORS.indexOf(value as (typeof ANCHORS)[number]));
  } else if (value instanceof Color) {
    const alpha = value.a;
    out[offset] = alpha > 0 ? value.r / alpha : 0;
    out[offset + 1] = alpha > 0 ? value.g / alpha : 0;
    out[offset + 2] = alpha > 0 ? value.b / alpha : 0;
    out[offset + 3] = alpha;
  } else if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) out[offset + i] = Number(value[i]);
  } else {
    out[offset] = value === undefined || value === null ? 0 : Number(value);
  }
  return undefined;
}
