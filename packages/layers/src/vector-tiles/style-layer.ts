/**
 * One layer of a MapLibre Style Specification style, compiled by the specification's own expression engine
 * (`@maplibre/maplibre-gl-style-spec`, ISC; ADR 0034): its filter, paint and layout properties with the
 * specification's defaults, zoom range and visibility, and feature-state (F446, F447).
 */
import {
  Color,
  createPropertyExpression,
  featureFilter,
  latest,
  type FilterSpecification,
  type StylePropertySpecification,
} from '@maplibre/maplibre-gl-style-spec';

/** The layer types of the pinned style specification (26.x, ADR 0034). */
export const STYLE_LAYER_TYPES = [
  'background',
  'fill',
  'line',
  'symbol',
  'circle',
  'fill-extrusion',
  'raster',
  'hillshade',
  'heatmap',
  'color-relief',
] as const;

/** A style layer type. */
export type StyleLayerType = (typeof STYLE_LAYER_TYPES)[number];

/** A color as the layers read it: straight (not premultiplied) RGBA in 0–1. */
export interface StyleColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** A feature as filters and expressions see it (an MVT feature fits). */
export interface StyleFeatureInput {
  readonly id?: string | number | undefined;
  /** 'Point', 'LineString' or 'Polygon' (or 'Unknown'). */
  readonly type: string;
  readonly properties: Readonly<Record<string, unknown>>;
}

/** Per-feature runtime state for `['feature-state', …]`. */
export type FeatureStateMap = Readonly<Record<string, unknown>>;

/** A layer's JSON as the style holds it (the specification's `LayerSpecification`, loosely typed). */
export interface StyleLayerJson {
  readonly id: string;
  readonly type: string;
  readonly source?: string;
  readonly 'source-layer'?: string;
  readonly minzoom?: number;
  readonly maxzoom?: number;
  readonly filter?: unknown;
  readonly layout?: Readonly<Record<string, unknown>>;
  readonly paint?: Readonly<Record<string, unknown>>;
  readonly metadata?: unknown;
}

interface Compiled {
  readonly kind: 'constant' | 'source' | 'camera' | 'composite';
  evaluate(globals: { zoom: number }, feature?: unknown, featureState?: unknown): unknown;
}

/** A property or filter that failed to compile, with its JSON path inside the layer. */
export interface LayerProblem {
  readonly path: string;
  readonly message: string;
}

/** Converts the specification's value classes to plain values, keeping its types out of this package's API. */
export function plainValue(value: unknown): unknown {
  if (value instanceof Color) {
    const a = value.a;
    return a > 0 ? { r: value.r / a, g: value.g / a, b: value.b / a, a } : { r: 0, g: 0, b: 0, a: 0 };
  }
  if (value !== null && typeof value === 'object') {
    const sections = (value as { sections?: readonly { text: string }[] }).sections;
    if (Array.isArray(sections)) return sections.map((s: { text: string }) => s.text).join('');
    const name = (value as { name?: unknown }).name;
    if (typeof name === 'string' && 'available' in value) return name;
    const values = (value as { values?: unknown }).values;
    if (Array.isArray(values)) return values.map(plainValue);
  }
  return value;
}

function propertySpec(group: 'paint' | 'layout', type: string, name: string): StylePropertySpecification | undefined {
  const reference = latest as unknown as Record<string, Record<string, StylePropertySpecification> | undefined>;
  return reference[`${group}_${type}`]?.[name];
}

/** Compiles one property value, or reports why it cannot be compiled. */
export function compileProperty(
  group: 'paint' | 'layout',
  type: string,
  name: string,
  value: unknown,
): { expression: Compiled } | { problem: string } {
  const spec = propertySpec(group, type, name);
  if (spec === undefined) return { problem: `unknown ${group} property "${name}" for a ${type} layer` };
  if (value === undefined) value = (spec as { default?: unknown }).default;
  if (value === undefined) return { expression: { kind: 'constant', evaluate: () => undefined } };
  const compiled = createPropertyExpression(value, name, spec);
  if (compiled.result === 'error') return { problem: compiled.value.map((e) => `${e.key} ${e.message}`).join('; ') };
  return { expression: compiled.value as unknown as Compiled };
}

/** A compiled style layer. Runtime changes go through `VectorStyle`, which reports them to the renderer. */
export class StyleLayer {
  readonly id: string;
  readonly type: StyleLayerType;
  readonly source: string | undefined;
  readonly sourceLayer: string | undefined;
  minzoom: number;
  maxzoom: number;
  /** The layer's JSON, kept current by runtime changes. */
  json: StyleLayerJson;
  private filterFn: ((zoom: number, feature: StyleFeatureInput) => boolean) | undefined;
  private readonly compiled = new Map<string, Compiled>();

  /** Compiles `json`; problems are collected in `problems` and the offending properties fall back to defaults. */
  constructor(
    json: StyleLayerJson,
    readonly problems: LayerProblem[] = [],
  ) {
    this.id = json.id;
    this.type = json.type as StyleLayerType;
    this.source = json.source;
    this.sourceLayer = json['source-layer'];
    this.minzoom = json.minzoom ?? 0;
    this.maxzoom = json.maxzoom ?? 24;
    this.json = json;
    this.setFilter(json.filter);
    for (const group of ['paint', 'layout'] as const) {
      for (const [name, value] of Object.entries(json[group] ?? {})) {
        const problem = this.setProperty(group, name, value);
        if (problem !== undefined) problems.push(problem);
      }
    }
  }

  /** Whether the layer is visible (`layout.visibility`). */
  get visible(): boolean {
    return this.json.layout?.['visibility'] !== 'none';
  }

  /** Whether `zoom` lies in the layer's range, `minzoom <= zoom < maxzoom` (specification semantics). */
  inZoomRange(zoom: number): boolean {
    return zoom >= this.minzoom && zoom < this.maxzoom;
  }

  /** Sets or replaces the filter; an invalid filter is reported and leaves the old one in place. */
  setFilter(filter: unknown): LayerProblem | undefined {
    if (filter === undefined || filter === null) {
      this.filterFn = undefined;
      this.json = { ...this.json, filter: undefined };
      return undefined;
    }
    try {
      const compiled = featureFilter(filter as FilterSpecification, `layers.${this.id}.filter`);
      this.filterFn = (zoom, feature) => compiled.filter({ zoom }, feature as never);
      this.json = { ...this.json, filter };
      return undefined;
    } catch (error) {
      return { path: 'filter', message: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Sets one paint or layout property; `undefined` restores the default. An invalid value is reported and ignored. */
  setProperty(group: 'paint' | 'layout', name: string, value: unknown): LayerProblem | undefined {
    const result = compileProperty(group, this.type, name, value);
    if ('problem' in result) return { path: `${group}.${name}`, message: result.problem };
    this.compiled.set(`${group}.${name}`, result.expression);
    const next = Object.fromEntries(Object.entries(this.json[group] ?? {}).filter(([key]) => key !== name));
    if (value !== undefined) next[name] = value;
    this.json = { ...this.json, [group]: next };
    return undefined;
  }

  /** Whether a feature passes the filter at `zoom` (filters do not read feature-state, per the specification). */
  filter(zoom: number, feature: StyleFeatureInput): boolean {
    return this.filterFn === undefined ? true : this.filterFn(zoom, feature);
  }

  /** Evaluates a paint property (the specification's default when unset), as a plain value. */
  paint(name: string, zoom: number, feature?: StyleFeatureInput, state?: FeatureStateMap): unknown {
    return this.evaluate('paint', name, zoom, feature, state);
  }

  /** Evaluates a layout property (the specification's default when unset), as a plain value. */
  layout(name: string, zoom: number, feature?: StyleFeatureInput): unknown {
    return this.evaluate('layout', name, zoom, feature);
  }

  /** How a property varies: 'constant', 'source' (per feature), 'camera' (per zoom) or 'composite'. */
  propertyKind(group: 'paint' | 'layout', name: string): Compiled['kind'] | undefined {
    return this.expression(group, name)?.kind;
  }

  private expression(group: 'paint' | 'layout', name: string): Compiled | undefined {
    const key = `${group}.${name}`;
    let compiled = this.compiled.get(key);
    if (compiled === undefined) {
      const result = compileProperty(group, this.type, name, undefined);
      if ('problem' in result) return undefined;
      compiled = result.expression;
      this.compiled.set(key, compiled);
    }
    return compiled;
  }

  private evaluate(
    group: 'paint' | 'layout',
    name: string,
    zoom: number,
    feature?: StyleFeatureInput,
    state?: FeatureStateMap,
  ): unknown {
    const compiled = this.expression(group, name);
    if (compiled === undefined) return undefined;
    return plainValue(compiled.evaluate({ zoom }, feature, state));
  }
}
