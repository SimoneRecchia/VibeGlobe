import { PbfWriter } from 'pbf';
import { describe, expect, it } from 'vitest';
import { decodeGlyphs, GlyphStore, glyphRanges, glyphUrl, parseSpriteIndex, spriteUrls, type Glyph } from './glyphs.js';
import { lineAnchors, placeGlyphsAlongLine } from './line-labels.js';
import { brunnel, localizedName, localizedTextField, placePriority, roadClass, roadDrawOrder } from './osm.js';
import { CrossTileSymbolIndex, placeSymbols, SymbolFader, type SymbolCandidate } from './symbol-placement.js';
import { DEFAULT_SHAPING, shapeText } from './text-shaping.js';
import { StyleLayer } from './style-layer.js';

/** Encodes glyphs in the glyph-server PBF format, 10 px wide and 14 px high, advance 12. */
function glyphPbf(name: string, codes: readonly number[]): Uint8Array {
  const pbf = new PbfWriter();
  pbf.writeMessage(
    1,
    (_: unknown, w: PbfWriter) => {
      w.writeStringField(1, name);
      w.writeStringField(2, '0-255');
      for (const code of codes) {
        w.writeMessage(
          3,
          (__: unknown, g: PbfWriter) => {
            g.writeVarintField(1, code);
            g.writeBytesField(2, new Uint8Array(16 * 20));
            g.writeVarintField(3, 10);
            g.writeVarintField(4, 14);
            g.writeSVarintField(5, 1);
            g.writeSVarintField(6, -10);
            g.writeVarintField(7, 12);
          },
          undefined,
        );
      }
    },
    undefined,
  );
  return pbf.finish();
}

function store(): GlyphStore {
  const s = new GlyphStore();
  const latin = [...'abcdefghijklmnopqrstuvwxyzMR '].map((c) => c.codePointAt(0) ?? 0);
  s.add(['Noto Sans Regular'], 0, decodeGlyphs(glyphPbf('Noto Sans Regular', latin)));
  const greekCyrillic = [...'ΑθήναМосква'].map((c) => c.codePointAt(0) ?? 0);
  s.add(['Noto Sans Regular'], 768, decodeGlyphs(glyphPbf('Noto Sans Regular', greekCyrillic)));
  s.add(
    ['Noto Sans CJK'],
    0x6700,
    decodeGlyphs(
      glyphPbf(
        'Noto Sans CJK',
        [...'東京都'].map((c) => c.codePointAt(0) ?? 0),
      ),
    ),
  );
  return s;
}

const STACKS = [['Noto Sans Regular'], ['Noto Sans CJK']];

describe('glyphs and sprites (F448)', () => {
  it('requests only the ranges of the characters in use, from the style template', () => {
    expect(glyphRanges('Roma')).toEqual([0]);
    expect(glyphRanges('Αθήνα Москва 東京')).toEqual([0, 768, 1024, 0x4e00, 0x6700]);
    expect(glyphUrl('https://t.example/fonts/{fontstack}/{range}.pbf', ['Noto Sans Regular', 'Arial'], 256)).toBe(
      'https://t.example/fonts/Noto%20Sans%20Regular%2CArial/256-511.pbf',
    );
    const s = store();
    expect(s.missingRanges(['Noto Sans Regular'], 'Roma Москва')).toEqual([1024]);
  });

  it('decodes glyph files and never throws on garbage', () => {
    const glyphs = decodeGlyphs(glyphPbf('X', [65, 66]));
    expect([...glyphs.keys()]).toEqual([65, 66]);
    expect(glyphs.get(65)).toMatchObject({ width: 10, height: 14, left: 1, top: -10, advance: 12 });
    expect(decodeGlyphs(new Uint8Array([0xff, 0xff, 0xff, 0x01])).size).toBe(0);
  });

  it('uses the 2x sprite sheets above pixel ratio 1 and parses sprite indexes', () => {
    expect(spriteUrls('https://t.example/sprite?key=1', 2)).toEqual([
      { id: '', json: 'https://t.example/sprite@2x.json?key=1', png: 'https://t.example/sprite@2x.png?key=1' },
    ]);
    expect(spriteUrls([{ id: 'poi', url: 'https://t.example/poi' }], 1)[0]?.png).toBe('https://t.example/poi.png');
    const icons = parseSpriteIndex(
      { bus: { x: 0, y: 0, width: 42, height: 42, pixelRatio: 2 }, bad: { x: 'a' } },
      'poi',
    );
    expect([...icons.keys()]).toEqual(['poi:bus']);
    expect(icons.get('poi:bus')?.pixelRatio).toBe(2);
  });

  it('renders Latin, Greek, Cyrillic and CJK from the first font stack that has them, with no missing boxes', () => {
    const s = store();
    const shaped = shapeText('Roma Αθήνα Москва 東京都', (code) => s.resolve(code, STACKS), {
      ...DEFAULT_SHAPING,
      maxWidthEm: 0,
    });
    expect(shaped.missing).toEqual([]);
    expect(new Set(shaped.glyphs.map((g) => g.fontStack))).toEqual(new Set(['Noto Sans Regular', 'Noto Sans CJK']));
    const tofu = shapeText('a\u{1F600}b', (code) => s.resolve(code, STACKS));
    expect(tofu.missing).toEqual([0x1f600]);
    expect(tofu.glyphs.map((g) => g.code)).toEqual([97, 98]);
  });
});

describe('text shaping (F448, F449)', () => {
  const glyph: Glyph = { id: 0, bitmap: new Uint8Array(0), width: 10, height: 14, left: 0, top: -10, advance: 12 };
  const lookup = (code: number) => ({ glyph: { ...glyph, id: code }, fontStack: 'f' });

  it('breaks at text-max-width at spaces and between ideographs', () => {
    // 12 px per character; a 2-em (48 px) line holds 4 characters.
    const shaped = shapeText('aaa bbb ccc', lookup, { ...DEFAULT_SHAPING, maxWidthEm: 2 });
    expect(shaped.lineCount).toBe(3);
    const cjk = shapeText('東京都東京都', lookup, { ...DEFAULT_SHAPING, maxWidthEm: 2 });
    expect(cjk.lineCount).toBe(2);
  });

  it('anchors and justifies the text box', () => {
    const center = shapeText('abcd', lookup);
    expect([center.left, center.right]).toEqual([-24, 24]);
    const topLeft = shapeText('abcd', lookup, { ...DEFAULT_SHAPING, anchor: 'top-left' });
    expect([topLeft.left, topLeft.top]).toEqual([0, 0]);
    const right = shapeText('ab\nabcd', lookup, { ...DEFAULT_SHAPING, justify: 'right' });
    expect(right.glyphs.filter((g) => g.line === 0).map((g) => g.x)).toEqual([0, 12]);
    const spaced = shapeText('ab', lookup, { ...DEFAULT_SHAPING, letterSpacingEm: 0.5 });
    expect(spaced.right - spaced.left).toBe(36);
  });
});

describe('labels along lines (F449)', () => {
  const road = [
    [0, 100],
    [2000, 100],
    [2000, 1100],
  ] as const;

  it('anchors labels every symbol-spacing, inside the tile only, not on sharp bends', () => {
    const anchors = lineAnchors(road, { spacing: 500, labelLength: 200, maxAngleDeg: 45, extent: 4096 });
    expect(anchors.map((a) => Math.round(a.distance))).toEqual([250, 750, 1250, 1750, 2250, 2750]);
    const crossing = lineAnchors(
      [
        [3500, 50],
        [5000, 50],
      ],
      { spacing: 500, labelLength: 100, maxAngleDeg: 45, extent: 4096 },
    );
    expect(crossing.every((a) => a.x < 4096)).toBe(true);
    const nextTile = lineAnchors(
      [
        [-596, 50],
        [904, 50],
      ],
      { spacing: 500, labelLength: 100, maxAngleDeg: 45, extent: 4096 },
    );
    expect(nextTile.every((a) => a.x >= 0)).toBe(true);
    expect(crossing.length + nextTile.length).toBe(3);
    const tight = lineAnchors(
      [
        [0, 0],
        [100, 0],
        [100, 100],
      ],
      { spacing: 1000, labelLength: 150, maxAngleDeg: 45, extent: 4096 },
    );
    expect(tight).toEqual([]);
  });

  it('places glyphs along a curve and keeps text upright', () => {
    const anchors = lineAnchors(road, { spacing: 2000, labelLength: 200, maxAngleDeg: 100, extent: 4096 });
    const glyphs = placeGlyphsAlongLine(road, anchors[0] as (typeof anchors)[number], [-60, 0, 1060]);
    expect(glyphs?.map((g) => [Math.round(g.x), Math.round(g.y)])).toEqual([
      [940, 100],
      [1000, 100],
      [2000, 160],
    ]);
    const backwards = [
      [1000, 0],
      [0, 0],
    ] as const;
    const [anchor] = lineAnchors(backwards, { spacing: 2000, labelLength: 100, maxAngleDeg: 45, extent: 4096 });
    const upright = placeGlyphsAlongLine(backwards, anchor as NonNullable<typeof anchor>, [-10, 10]);
    expect(upright?.map((g) => Math.round(g.x))).toEqual([490, 510]);
    expect(Math.cos(upright?.[0]?.angleRad ?? Math.PI)).toBeGreaterThan(0.99);
  });
});

describe('symbol collision, priorities, cross-tile ids and fades (F449, F454)', () => {
  const box = (x: number, y: number, w = 40, h = 10) => ({ minX: x, minY: y, maxX: x + w, maxY: y + h });
  const viewport = { minX: 0, minY: 0, maxX: 800, maxY: 600 };

  it('places no two labels overlapping, higher priority first', () => {
    const candidates: SymbolCandidate[] = [
      { id: 1, boxes: [box(100, 100)], layerIndex: 3, sortKey: 5 },
      { id: 2, boxes: [box(110, 102)], layerIndex: 3, sortKey: 1 },
      { id: 3, boxes: [box(120, 104)], layerIndex: 9, sortKey: 9 },
      { id: 4, boxes: [box(400, 100)], layerIndex: 0, sortKey: 0 },
      { id: 5, boxes: [box(790, 100)], layerIndex: 0, sortKey: 0 },
    ];
    const { placed } = placeSymbols(candidates, viewport);
    expect([...placed].sort()).toEqual([3, 4]);
  });

  it('gives a label the same id in a parent and its child tile, and removes it with its last tile', () => {
    const index = new CrossTileSymbolIndex();
    const [parent] = index.addTile('10/1/1', 10, [{ key: 'places|Milano', worldX: 0.5, worldY: 0.3 }]);
    const [child] = index.addTile('11/2/2', 11, [{ key: 'places|Milano', worldX: 0.5 + 1e-8, worldY: 0.3 }]);
    expect(child).toBe(parent);
    index.removeTile('10/1/1');
    expect(index.size).toBe(1);
    const [far] = index.addTile('11/2/3', 11, [{ key: 'places|Milano', worldX: 0.6, worldY: 0.3 }]);
    expect(far).not.toBe(parent);
    index.removeTile('11/2/2');
    index.removeTile('11/2/3');
    expect(index.size).toBe(0);
  });

  it('fades labels in and out instead of flickering', () => {
    const fader = new SymbolFader(300);
    expect(fader.update(0, new Set([1])).get(1)).toBe(0);
    expect(fader.update(150, new Set([1])).get(1)).toBeCloseTo(0.5, 6);
    expect(fader.update(300, new Set([1, 2])).get(1)).toBe(1);
    expect(fader.update(330, new Set([2])).get(1)).toBeCloseTo(0.9, 6);
  });

  it('ranks places by class, capital status and population', () => {
    const rome = placePriority({ class: 'city', capital: 2, population: 2_800_000 });
    const milan = placePriority({ class: 'city', population: 1_400_000 });
    const como = placePriority({ class: 'city', population: 83_000 });
    const town = placePriority({ class: 'town', population: 500_000 });
    const lombardy = placePriority({ class: 'state' });
    expect([lombardy, rome, milan, como, town]).toEqual([lombardy, rome, milan, como, town].sort((a, b) => a - b));
  });

  it('labels places in the configured language with a fallback to name', () => {
    const milan = { name: 'Milano', 'name:en': 'Milan', name_it: 'Milano' };
    expect(localizedName(milan, 'en')).toBe('Milan');
    expect(localizedName(milan, 'it')).toBe('Milano');
    expect(localizedName({ name: 'Bergamo' }, 'en')).toBe('Bergamo');
    const layer = new StyleLayer({
      id: 'p',
      type: 'symbol',
      source: 's',
      layout: { 'text-field': localizedTextField('en') },
    });
    expect(layer.problems).toEqual([]);
    expect(layer.layout('text-field', 10, { type: 'Point', properties: milan })).toBe('Milan');
    expect(layer.layout('text-field', 10, { type: 'Point', properties: { name: 'Lodi' } })).toBe('Lodi');
  });
});

describe('OpenStreetMap roads (F453)', () => {
  it('classifies roads from motorways to paths', () => {
    expect(['motorway_link', 'residential', 'footway', 'river'].map((h) => roadClass({ highway: h }))).toEqual([
      'motorway',
      'minor',
      'path',
      undefined,
    ]);
    expect(roadClass({ class: 'primary' })).toBe('primary');
  });

  it('draws tunnels below ground roads below bridges, then by layer and importance', () => {
    const tunnel = roadDrawOrder({ class: 'motorway', brunnel: 'tunnel' });
    const path = roadDrawOrder({ highway: 'path' });
    const primary = roadDrawOrder({ highway: 'primary' });
    const bridge = roadDrawOrder({ highway: 'service', bridge: 'yes' });
    const highBridge = roadDrawOrder({ highway: 'service', bridge: 'viaduct', layer: 2 });
    expect([tunnel, path, primary, bridge, highBridge]).toEqual(
      [tunnel, path, primary, bridge, highBridge].sort((a, b) => a - b),
    );
    expect(brunnel({ tunnel: 'no' })).toBe('ground');
  });
});
