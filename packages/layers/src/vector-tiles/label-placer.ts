// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Places the labels of the drawn tiles each frame (F448, F449, F454; ADR 0132): projects their anchors to the screen,
 * hides those behind the globe, lays point labels out around their anchor and line labels glyph by glyph along their
 * road (upright on screen), runs collision in priority order (higher style layers, then `symbol-sort-key`), fades
 * labels in and out on the engine clock, and writes the quads of the visible glyphs for the target's text material.
 */
import { LabelAnchorCache } from './label-anchor-cache.js';
import { geodeticToEcef, type ElevationSample, type FrameView, type GeoPosition } from '@vibeglobe/core';
import { tileToLonLat } from './globe-vertices.js';
import { GlyphSource } from './glyph-source.js';
import { labelAnchors, UNITS_PER_PX, type LabelAnchor } from './label-anchors.js';
import { BUCKET_EXTENT, type Bucket, type BucketFeature } from './layout-tile.js';
import { placeGlyphsAlongLine } from './line-labels.js';
import type { StyleLayer } from './style-layer.js';
import {
  CrossTileSymbolIndex,
  placeSymbols,
  SymbolFader,
  type ScreenBox,
  type SymbolCandidate,
} from './symbol-placement.js';
import { DEFAULT_SHAPING, shapeText, type Shaping, type ShapingOptions, type TextAnchor } from './text-shaping.js';
import type { TileId } from './tile-pyramid.js';
import { linearColor } from './vector-paint.js';
import { QuadWriter, type GlyphQuad } from './label-quads.js';
import type { LabelQuads, VectorAtlas } from './vector-target.js';

/** One symbol bucket drawn this frame, with the target square it covers. */
export interface LabelSource {
  readonly layer: StyleLayer;
  readonly layerIndex: number;
  /** The layer's fade (0–1). */
  readonly opacity: number;
  readonly tile: TileId;
  readonly clip: readonly [number, number, number, number];
  readonly bucket: Bucket;
  /** The layout version of the bucket (anchors are cached per version). */
  readonly version: number;
}

/** The screen projection and height queries the placer needs (the globe). */
export interface LabelView {
  geoToScreen(position: {
    longitudeDeg: number;
    latitudeDeg: number;
    heightMeters?: number;
  }): { xPx: number; yPx: number } | undefined;
  readonly camera: { readonly morphFactor: number };
  /** Terrain heights, so labels stand on the relief. */
  elevationAt?(position: GeoPosition, out?: ElevationSample): ElevationSample;
}

/** A placed label, for the debug API (F449). */
export interface PlacedLabel {
  readonly id: number;
  readonly layerId: string;
  readonly text: string;
  readonly boxes: readonly ScreenBox[];
  readonly opacity: number;
  /** The style source, the feature and the anchor's position, for picking (F459). */
  readonly source: string;
  readonly feature: BucketFeature;
  readonly position: { readonly longitudeDeg: number; readonly latitudeDeg: number };
}

interface Candidate extends SymbolCandidate {
  readonly layerId: string;
  readonly text: string;
  readonly source: string;
  readonly feature: BucketFeature;
  readonly position: { readonly longitudeDeg: number; readonly latitudeDeg: number };
  readonly glyphs: readonly GlyphQuad[];
  readonly opacity: number;
}

const ecef = new Float64Array(3);
const RAD = Math.PI / 180;

/**
 * How far outside the viewport, in CSS pixels, an anchor may lie and its label still be placed: every box of a placed
 * label lies in the viewport, and a label's boxes surround its anchor (point labels up to their `text-offset`).
 */
const CULL_MARGIN_PX = 128;

/** Whether a point on the globe faces the eye (from the flat map's half of the morph on, everything does). */
function facing(lon: number, lat: number, view: FrameView, morph: number): boolean {
  if (morph >= 0.5) return true;
  geodeticToEcef(lon * RAD, lat * RAD, 0, ecef);
  const [x, y, z] = [ecef[0] ?? 0, ecef[1] ?? 0, ecef[2] ?? 0];
  const e = view.eyeEcef;
  return x * ((e[0] ?? 0) - x) + y * ((e[1] ?? 0) - y) + z * ((e[2] ?? 0) - z) > 0;
}

function shapingOptions(
  layer: StyleLayer,
  zoom: number,
  feature: Bucket['features'][number] | undefined,
  onLine: boolean,
): ShapingOptions {
  const l = (name: string) => layer.layout(name, zoom, feature);
  const offset = l('text-offset');
  return {
    maxWidthEm: onLine ? 0 : Number(l('text-max-width') ?? DEFAULT_SHAPING.maxWidthEm),
    lineHeightEm: Number(l('text-line-height') ?? DEFAULT_SHAPING.lineHeightEm),
    letterSpacingEm: Number(l('text-letter-spacing') ?? 0),
    justify: (l('text-justify') as ShapingOptions['justify'] | undefined) ?? 'center',
    anchor: onLine ? 'center' : ((l('text-anchor') as TextAnchor | undefined) ?? 'center'),
    offsetEm: Array.isArray(offset) ? [Number(offset[0]) || 0, Number(offset[1]) || 0] : [0, 0],
  };
}

/** Text shapings kept before they start over. */
const MAX_SHAPINGS = 8192;

/** Labels of a vector tile layer: anchors per tile, placement and fades per frame. */
export class LabelPlacer {
  private readonly index = new CrossTileSymbolIndex();
  private readonly fader = new SymbolFader();
  private readonly anchors = new LabelAnchorCache<LabelAnchor[]>();
  private readonly shapings = new Map<string, Shaping>();
  private readonly quads = new QuadWriter();
  private placedLabels: PlacedLabel[] = [];

  constructor(
    private readonly view: LabelView,
    readonly glyphs: GlyphSource,
    private readonly atlas: VectorAtlas,
    private readonly stateOf: (source: string, id: number) => Readonly<Record<string, unknown>> | undefined = () =>
      undefined,
  ) {}

  /** The screen point of a position on the ground (on the terrain where there is some, F452). */
  private project(longitudeDeg: number, latitudeDeg: number): { xPx: number; yPx: number } | undefined {
    const position = { longitudeDeg, latitudeDeg, heightMeters: 0 };
    if (this.view.elevationAt !== undefined)
      position.heightMeters = this.view.elevationAt(position, this.sample).heightMeters;
    return this.view.geoToScreen(position);
  }

  private readonly sample = { heightMeters: 0, level: -1, noData: true };

  /** The labels placed by the last frame. */
  placed(): readonly PlacedLabel[] {
    return this.placedLabels;
  }

  /** Places the frame's labels; returns their quads and whether a fade is running. */
  frame(
    sources: readonly LabelSource[],
    view: FrameView,
    zoom: number,
    nowMs: number,
  ): { quads: LabelQuads; animating: boolean } {
    const candidates: Candidate[] = [];
    const morph = this.view.camera.morphFactor;
    this.anchors.beginFrame();
    for (const source of sources) for (const c of this.candidates(source, view, zoom, morph)) candidates.push(c);
    this.anchors.endFrame(this.index);
    const viewport = { minX: 0, minY: 0, maxX: view.widthPx, maxY: view.heightPx };
    const { placed } = placeSymbols(candidates, viewport);
    const opacities = this.fader.update(nowMs, placed);
    this.quads.reset();
    const shown: PlacedLabel[] = [];
    let animating = false;
    const seen = new Set<number>();
    for (const c of candidates) {
      const opacity = opacities.get(c.id) ?? 0;
      if (opacity > 0 && opacity < 1) animating = true;
      if (opacity <= 0 || seen.has(c.id)) continue;
      seen.add(c.id);
      for (const g of c.glyphs) this.quads.add(g, opacity * c.opacity);
      if (placed.has(c.id))
        shown.push({
          id: c.id,
          layerId: c.layerId,
          text: c.text,
          boxes: c.boxes,
          opacity,
          source: c.source,
          feature: c.feature,
          position: c.position,
        });
    }
    this.placedLabels = shown;
    return { quads: this.quads.result(), animating };
  }

  private shaping(source: LabelSource, label: number, zoom: number, onLine: boolean): Shaping | undefined {
    const { layer, bucket } = source;
    const l = bucket.labels?.[label];
    if (l === undefined) return undefined;
    const feature = bucket.features[l.feature];
    const font = (layer.layout('text-font', zoom, feature) as string[] | undefined) ?? ['Open Sans Regular'];
    this.glyphs.need(font, l.text);
    if (!this.glyphs.ready(font, l.text)) return undefined;
    const options = shapingOptions(layer, zoom, feature, onLine);
    const key = `${font.join(',')}|${l.text}|${JSON.stringify(options)}`;
    let shaping = this.shapings.get(key);
    if (shaping === undefined) {
      shaping = shapeText(l.text, (code) => this.glyphs.resolve(code, font), options);
      if (this.shapings.size >= MAX_SHAPINGS) this.shapings.clear();
      this.shapings.set(key, shaping);
    }
    return shaping;
  }

  private anchorsOf(source: LabelSource): LabelAnchor[] | undefined {
    const key = `${source.tile.z}/${source.tile.x}/${source.tile.y}|${source.layer.id}|${source.version}`;
    let list = this.anchors.get(key);
    if (list !== undefined) return list;
    let ready = true;
    list = labelAnchors(source.layer, source.bucket, source.tile, this.index, (label) => {
      const shaping = this.shaping(source, label, source.tile.z, true);
      if (shaping === undefined) ready = false;
      return shaping === undefined ? undefined : shaping.right - shaping.left;
    });
    // Line anchors need the label lengths: until the glyphs arrive, try again next frame.
    if (ready) this.anchors.set(key, list);
    return list;
  }

  private candidates(source: LabelSource, view: FrameView, zoom: number, morph: number): Candidate[] {
    const out: Candidate[] = [];
    const { layer, bucket, tile, clip } = source;
    for (const anchor of this.anchorsOf(source) ?? []) {
      if (anchor.x < clip[0] || anchor.y < clip[1] || anchor.x >= clip[2] || anchor.y >= clip[3]) continue;
      const label = bucket.labels?.[anchor.label];
      if (label === undefined) continue;
      const [lon, lat] = tileToLonLat(tile, BUCKET_EXTENT, anchor.x, anchor.y);
      if (!facing(lon ?? 0, lat ?? 0, view, morph)) continue;
      const screen = this.project(lon ?? 0, lat ?? 0);
      if (screen === undefined) continue;
      // A label whose anchor is off screen can never be placed: it is not shaped, styled or laid out (KB-210).
      if (
        screen.xPx < -CULL_MARGIN_PX ||
        screen.yPx < -CULL_MARGIN_PX ||
        screen.xPx > view.widthPx + CULL_MARGIN_PX ||
        screen.yPx > view.heightPx + CULL_MARGIN_PX
      )
        continue;
      const feature = bucket.features[label.feature];
      const shaping = this.shaping(source, anchor.label, zoom, anchor.onLine !== undefined);
      if (shaping === undefined) continue;
      const size = Number(layer.layout('text-size', zoom, feature)) || 16;
      const state = feature?.id === undefined ? undefined : this.stateOf(layer.source ?? '', feature.id);
      const paint = (name: string) => layer.paint(name, zoom, feature, state);
      const style = { scale: size / 24, ...labelColors(paint) };
      const icon = anchor.onLine === undefined ? this.iconQuad(label.icon, screen, layer, zoom, feature) : undefined;
      if (icon === null) continue;
      const glyphs =
        anchor.onLine === undefined
          ? this.pointGlyphs(shaping, screen, style)
          : this.lineGlyphs(shaping, anchor, source, zoom, style);
      if (glyphs === undefined || glyphs.length + (icon === undefined ? 0 : 1) === 0) continue;
      const boxes =
        anchor.onLine === undefined
          ? [...(glyphs.length > 0 ? [this.pointBox(shaping, screen, style.scale)] : []), ...(icon ? [icon.box] : [])]
          : glyphs.map((g) => g.box);
      if (icon !== undefined) glyphs.unshift(icon);
      out.push({
        id: anchor.id,
        boxes,
        layerIndex: source.layerIndex,
        sortKey: Number(layer.layout('symbol-sort-key', zoom, feature) ?? 0),
        allowOverlap: layer.layout('text-allow-overlap', zoom, feature) === true,
        ignorePlacement: layer.layout('text-ignore-placement', zoom, feature) === true,
        layerId: layer.id,
        text: label.text,
        glyphs,
        opacity: source.opacity,
        source: layer.source ?? '',
        feature: feature ?? { id: undefined, type: 'Point', properties: {} },
        position: { longitudeDeg: lon ?? 0, latitudeDeg: lat ?? 0 },
      });
    }
    return out;
  }

  /**
   * The quad of a point label's sprite icon, centered on its anchor at `icon-size` in CSS pixels (the sprite's own
   * pixel ratio taken out, so the 2x sheet draws at the same size, F448); undefined without an icon (none named, or
   * none in a sprite that loaded or failed: the text draws alone), null while the sprite loads.
   */
  private iconQuad(
    name: string | undefined,
    screen: { xPx: number; yPx: number },
    layer: StyleLayer,
    zoom: number,
    feature: BucketFeature | undefined,
  ): GlyphQuad | null | undefined {
    if (name === undefined) return undefined;
    const image = this.glyphs.icon(name);
    if (image === undefined) return this.glyphs.spriteLoading ? null : undefined;
    const key = `icon|${name}|${image.icon.pixelRatio}`;
    const rect = this.atlas.get(key) ?? this.atlas.addRgba(key, image.pixels, image.width, image.height);
    if (rect === undefined) return null;
    const size = Number(layer.layout('icon-size', zoom, feature) ?? 1) / image.icon.pixelRatio;
    const w = image.width * size;
    const h = image.height * size;
    const x = screen.xPx - w / 2;
    const y = screen.yPx - h / 2;
    const opacity = Number(layer.paint('icon-opacity', zoom, feature) ?? 1);
    return {
      rect,
      corners: [x, y, x + w, y, x + w, y + h, x, y + h],
      box: { minX: x, minY: y, maxX: x + w, maxY: y + h },
      scale: 1,
      fill: [1, 1, 1, opacity],
      halo: [0, 0, 0, 0],
      haloWidthPx: 0,
      icon: true,
    };
  }

  private pointBox(shaping: Shaping, screen: { xPx: number; yPx: number }, scale: number): ScreenBox {
    return {
      minX: screen.xPx + shaping.left * scale,
      minY: screen.yPx + shaping.top * scale,
      maxX: screen.xPx + shaping.right * scale,
      maxY: screen.yPx + shaping.bottom * scale,
    };
  }

  private pointGlyphs(
    shaping: Shaping,
    screen: { xPx: number; yPx: number },
    style: GlyphStyle,
  ): GlyphQuad[] | undefined {
    const out: GlyphQuad[] = [];
    for (const g of shaping.glyphs) {
      const rect = this.atlasRect(g.fontStack, g.code, g.glyph);
      if (rect === undefined) return undefined;
      const x = screen.xPx + (g.x + g.glyph.left - 3) * style.scale;
      const y = screen.yPx + (g.y - g.glyph.top - 3) * style.scale;
      const w = (g.glyph.width + 6) * style.scale;
      const h = (g.glyph.height + 6) * style.scale;
      out.push({
        ...style,
        rect,
        corners: [x, y, x + w, y, x + w, y + h, x, y + h],
        box: { minX: x, minY: y, maxX: x + w, maxY: y + h },
      });
    }
    return out;
  }

  /** Glyphs placed one by one along the line in tile units, projected, and turned to the screen's direction. */
  private lineGlyphs(
    shaping: Shaping,
    anchor: LabelAnchor,
    source: LabelSource,
    zoom: number,
    style: GlyphStyle,
  ): GlyphQuad[] | undefined {
    const onLine = anchor.onLine;
    if (onLine === undefined) return undefined;
    const unitsPerPx = UNITS_PER_PX / 2 ** (zoom - source.tile.z);
    const offsets = shaping.glyphs.map((g) => (g.x + g.glyph.advance / 2) * style.scale * unitsPerPx);
    const project = (x: number, y: number) => {
      const [lon, lat] = tileToLonLat(source.tile, BUCKET_EXTENT, x, y);
      return this.project(lon ?? 0, lat ?? 0);
    };
    // Upright on screen: the label runs left to right whatever the heading.
    const a = project(onLine.anchor.x, onLine.anchor.y);
    const b = project(
      onLine.anchor.x + Math.cos(onLine.anchor.angleRad) * 8,
      onLine.anchor.y + Math.sin(onLine.anchor.angleRad) * 8,
    );
    if (a === undefined || b === undefined) return undefined;
    const tileUpright = Math.cos(onLine.anchor.angleRad) >= 0;
    const screenRight = b.xPx >= a.xPx;
    const angle = tileUpright === screenRight ? onLine.anchor.angleRad : onLine.anchor.angleRad + Math.PI;
    const placed = placeGlyphsAlongLine(onLine.line, { ...onLine.anchor, angleRad: angle }, offsets);
    if (placed === undefined) return undefined;
    // One projection per glyph: each glyph turns to the direction between its neighbors on screen (KB-210); a lone
    // glyph projects a point ahead of it on the line.
    const centers: { xPx: number; yPx: number }[] = [];
    for (const p of placed) {
      const center = project(p.x, p.y);
      if (center === undefined) return undefined;
      centers.push(center);
    }
    const out: GlyphQuad[] = [];
    for (let i = 0; i < placed.length; i++) {
      const g = shaping.glyphs[i];
      const p = placed[i];
      const center = centers[i];
      if (g === undefined || p === undefined || center === undefined) continue;
      const rect = this.atlasRect(g.fontStack, g.code, g.glyph);
      if (rect === undefined) return undefined;
      let from = centers[i - 1] ?? center;
      let to = centers[i + 1] ?? center;
      if (from === to) {
        const ahead = project(p.x + Math.cos(p.angleRad) * 4, p.y + Math.sin(p.angleRad) * 4);
        if (ahead === undefined) return undefined;
        from = center;
        to = ahead;
      }
      out.push(rotatedGlyph(g, center, Math.atan2(to.yPx - from.yPx, to.xPx - from.xPx), rect, style));
    }
    return out;
  }

  private atlasRect(fontStack: string, code: number, glyph: GlyphQuadSource): GlyphQuad['rect'] | undefined {
    const key = `${fontStack}|${code}`;
    return this.atlas.get(key) ?? this.atlas.addSdf(key, glyph.bitmap, glyph.width + 6, glyph.height + 6);
  }
}

type GlyphStyle = Pick<GlyphQuad, 'scale' | 'fill' | 'halo' | 'haloWidthPx'>;
type GlyphQuadSource = { readonly bitmap: ArrayLike<number>; readonly width: number; readonly height: number };

/** A glyph's quad turned by `theta` around its point on the line (its baseline offset kept). */
function rotatedGlyph(
  g: Shaping['glyphs'][number],
  center: { xPx: number; yPx: number },
  theta: number,
  rect: GlyphQuad['rect'],
  style: GlyphStyle,
): GlyphQuad {
  const s = style.scale;
  const x0 = (g.glyph.left - 3 - g.glyph.advance / 2) * s;
  const y0 = (g.y - g.glyph.top - 3) * s;
  const x1 = x0 + (g.glyph.width + 6) * s;
  const y1 = y0 + (g.glyph.height + 6) * s;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const corners: number[] = [];
  for (const [x, y] of [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ] as const) {
    corners.push(center.xPx + x * cos - y * sin, center.yPx + x * sin + y * cos);
  }
  const xs = [corners[0], corners[2], corners[4], corners[6]] as number[];
  const ys = [corners[1], corners[3], corners[5], corners[7]] as number[];
  return {
    ...style,
    rect,
    corners,
    box: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
  };
}

/** A label's text and halo colors (straight linear RGBA) and halo width: `text-opacity` fades the halo with the text. */
export function labelColors(paint: (name: string) => unknown): {
  fill: [number, number, number, number];
  halo: [number, number, number, number];
  haloWidthPx: number;
} {
  const opacity = Number(paint('text-opacity') ?? 1);
  return {
    fill: linearColor(paint('text-color'), opacity),
    halo: linearColor(paint('text-halo-color'), opacity),
    haloWidthPx: Number(paint('text-halo-width') ?? 0),
  };
}
