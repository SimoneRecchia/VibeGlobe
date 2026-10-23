/**
 * A MapLibre Style Specification style loaded without edits (F444), validated on load with JSON paths (F451), and
 * changed at runtime (F450). Problems never throw: a property that fails validation falls back to its default, a layer
 * that cannot be built is left out, and the remaining layers render. Each runtime change is reported with what it
 * costs the renderer: `paint` is re-evaluated on the next frame, `layout` and `filter` rebuild the tile's buckets from
 * the decoded features it keeps, and none downloads a tile again (ADR 0041).
 */
import { validateStyleMin, type StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { StyleLayer, STYLE_LAYER_TYPES, type StyleLayerJson } from './style-layer.js';

/** One problem found in a style, with its JSON path (for example `layers[1].paint.fill-opacity`). */
export interface StyleProblem {
  readonly path: string;
  readonly message: string;
}

/** What a runtime change needs from the renderer. */
export type StyleChangeKind = 'paint' | 'layout' | 'filter' | 'visibility' | 'zoom-range' | 'order';

/** A runtime change of the style. */
export interface StyleChange {
  readonly kind: StyleChangeKind;
  readonly layerId: string;
}

/** Whether a change needs the tile buckets rebuilt from the kept features (never a new download). */
export function changeNeedsRelayout(change: StyleChange): boolean {
  return change.kind === 'layout' || change.kind === 'filter' || change.kind === 'order';
}

/** A source of the style, as declared. */
export interface StyleSourceJson {
  readonly type: string;
  readonly url?: string;
  readonly tiles?: readonly string[];
  readonly minzoom?: number;
  readonly maxzoom?: number;
  readonly bounds?: readonly number[];
  readonly attribution?: string;
  readonly scheme?: 'xyz' | 'tms';
  readonly promoteId?: unknown;
  readonly [key: string]: unknown;
}

const LAYER_PATH = /^layers\[(\d+)\](?:\.(paint|layout)\.([^:\s.]+))?/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validate(json: Record<string, unknown>): StyleProblem[] {
  try {
    return validateStyleMin(json as unknown as StyleSpecification).map((error) => {
      const separator = error.message.indexOf(': ');
      return separator < 0
        ? { path: '', message: error.message }
        : { path: error.message.slice(0, separator), message: error.message.slice(separator + 2) };
    });
  } catch (error) {
    return [{ path: '', message: `style could not be validated: ${String(error)}` }];
  }
}

/** Splits problems into whole layers to drop and single properties to reset to their defaults. */
function classify(problems: readonly StyleProblem[]): { dropLayers: Set<number>; dropProperties: Set<string> } {
  const dropLayers = new Set<number>();
  const dropProperties = new Set<string>();
  for (const problem of problems) {
    const match = LAYER_PATH.exec(problem.path);
    if (match === null) continue;
    const index = Number(match[1]);
    if (match[2] !== undefined && match[3] !== undefined) dropProperties.add(`${index}.${match[2]}.${match[3]}`);
    else dropLayers.add(index);
  }
  return { dropLayers, dropProperties };
}

function without(record: unknown, index: number, group: string, drop: ReadonlySet<string>): Record<string, unknown> {
  if (!isRecord(record)) return {};
  return Object.fromEntries(Object.entries(record).filter(([name]) => !drop.has(`${index}.${group}.${name}`)));
}

/** A loaded style. */
export class VectorStyle {
  /** Every problem found on load, in validation order. */
  readonly problems: StyleProblem[] = [];
  readonly version: number;
  readonly name: string | undefined;
  readonly sources: Readonly<Record<string, StyleSourceJson>>;
  /** The sprite as declared: one URL, or several with an id each (specification 26.x). */
  readonly sprite: string | readonly { readonly id: string; readonly url: string }[] | undefined;
  /** The glyphs URL template with `{fontstack}` and `{range}`. */
  readonly glyphs: string | undefined;
  private ordered: StyleLayer[] = [];
  private readonly listeners = new Set<(change: StyleChange) => void>();

  private constructor(json: Record<string, unknown>, problems: StyleProblem[]) {
    this.problems.push(...problems);
    this.version = typeof json['version'] === 'number' ? json['version'] : 8;
    this.name = typeof json['name'] === 'string' ? json['name'] : undefined;
    this.sources = isRecord(json['sources']) ? (json['sources'] as Record<string, StyleSourceJson>) : {};
    const sprite = json['sprite'];
    this.sprite = typeof sprite === 'string' || Array.isArray(sprite) ? (sprite as VectorStyle['sprite']) : undefined;
    this.glyphs = typeof json['glyphs'] === 'string' ? json['glyphs'] : undefined;
  }

  /**
   * Loads a style object (already parsed JSON). Never throws: malformed input yields an empty style whose `problems`
   * say why.
   */
  static load(input: unknown): VectorStyle {
    if (!isRecord(input)) {
      return new VectorStyle({}, [{ path: '', message: 'a style must be a JSON object' }]);
    }
    const problems = validate(input);
    const style = new VectorStyle(input, problems);
    const { dropLayers, dropProperties } = classify(problems);
    const layers = Array.isArray(input['layers']) ? (input['layers'] as unknown[]) : [];
    const seen = new Set<string>();
    layers.forEach((layer, index) => {
      if (dropLayers.has(index) || !isRecord(layer) || typeof layer['id'] !== 'string') return;
      if (seen.has(layer['id']) || !STYLE_LAYER_TYPES.includes(layer['type'] as never)) return;
      seen.add(layer['id']);
      const json = {
        ...layer,
        paint: without(layer['paint'], index, 'paint', dropProperties),
        layout: without(layer['layout'], index, 'layout', dropProperties),
      } as unknown as StyleLayerJson;
      style.build(json, `layers[${index}]`);
    });
    return style;
  }

  /** The layers in draw order (first drawn first). */
  get layers(): readonly StyleLayer[] {
    return this.ordered;
  }

  /** The layer with this id. */
  layer(id: string): StyleLayer | undefined {
    return this.ordered.find((layer) => layer.id === id);
  }

  /** The layers drawing one source layer of one source, in draw order. */
  layersFor(source: string, sourceLayer: string): StyleLayer[] {
    return this.ordered.filter((layer) => layer.source === source && layer.sourceLayer === sourceLayer);
  }

  /** Subscribes to runtime changes; returns the unsubscribe function. */
  onChange(listener: (change: StyleChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Sets a paint property; returns the problem and changes nothing when the value is invalid. */
  setPaintProperty(layerId: string, name: string, value: unknown): StyleProblem | undefined {
    return this.change(layerId, 'paint', (layer) => layer.setProperty('paint', name, value));
  }

  /** Sets a layout property (`visibility` included); returns the problem when the value is invalid. */
  setLayoutProperty(layerId: string, name: string, value: unknown): StyleProblem | undefined {
    const kind = name === 'visibility' ? 'visibility' : 'layout';
    return this.change(layerId, kind, (layer) => layer.setProperty('layout', name, value));
  }

  /** Shows or hides a layer. */
  setVisibility(layerId: string, visible: boolean): StyleProblem | undefined {
    return this.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
  }

  /** Replaces a layer's filter (`undefined` removes it). */
  setFilter(layerId: string, filter: unknown): StyleProblem | undefined {
    return this.change(layerId, 'filter', (layer) => layer.setFilter(filter));
  }

  /** Changes a layer's zoom range. */
  setLayerZoomRange(layerId: string, minzoom: number, maxzoom: number): StyleProblem | undefined {
    return this.change(layerId, 'zoom-range', (layer) => {
      layer.minzoom = minzoom;
      layer.maxzoom = maxzoom;
      return undefined;
    });
  }

  /** Adds a layer before `beforeId` (at the top when absent); returns its problems, or one when it cannot be added. */
  addLayer(json: StyleLayerJson, beforeId?: string): StyleProblem[] {
    if (this.layer(json.id) !== undefined) return [{ path: json.id, message: `layer "${json.id}" already exists` }];
    const probe = validate({ version: 8, sources: this.sources, layers: [json] });
    const { dropLayers } = classify(probe);
    if (dropLayers.size > 0 || !STYLE_LAYER_TYPES.includes(json.type as never)) {
      return probe.length > 0 ? probe : [{ path: json.id, message: `unsupported layer type "${json.type}"` }];
    }
    const before = beforeId === undefined ? -1 : this.ordered.findIndex((layer) => layer.id === beforeId);
    const problems = this.build(json, json.id, before < 0 ? this.ordered.length : before);
    this.emit({ kind: 'order', layerId: json.id });
    return problems;
  }

  /** Removes a layer; returns false when there is none with this id. */
  removeLayer(layerId: string): boolean {
    const index = this.ordered.findIndex((layer) => layer.id === layerId);
    if (index < 0) return false;
    this.ordered.splice(index, 1);
    this.emit({ kind: 'order', layerId });
    return true;
  }

  /** The style as JSON, with every runtime change applied. */
  serialize(): Record<string, unknown> {
    return {
      version: this.version,
      ...(this.name === undefined ? {} : { name: this.name }),
      sources: this.sources,
      ...(this.sprite === undefined ? {} : { sprite: this.sprite }),
      ...(this.glyphs === undefined ? {} : { glyphs: this.glyphs }),
      layers: this.ordered.map((layer) => ({ ...layer.json, minzoom: layer.minzoom, maxzoom: layer.maxzoom })),
    };
  }

  private build(json: StyleLayerJson, path: string, at = this.ordered.length): StyleProblem[] {
    const layerProblems: { path: string; message: string }[] = [];
    const layer = new StyleLayer(json, layerProblems);
    const problems = layerProblems.map((p) => ({ path: `${path}.${p.path}`, message: p.message }));
    this.problems.push(...problems);
    this.ordered.splice(at, 0, layer);
    return problems;
  }

  private change(
    layerId: string,
    kind: StyleChangeKind,
    apply: (layer: StyleLayer) => { path: string; message: string } | undefined,
  ): StyleProblem | undefined {
    const layer = this.layer(layerId);
    if (layer === undefined) return { path: layerId, message: `no layer "${layerId}"` };
    const problem = apply(layer);
    if (problem !== undefined) return { path: `${layerId}.${problem.path}`, message: problem.message };
    this.emit({ kind, layerId });
    return undefined;
  }

  private emit(change: StyleChange): void {
    for (const listener of this.listeners) listener(change);
  }
}
