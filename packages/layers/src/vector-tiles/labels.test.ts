import { PbfWriter } from 'pbf';
import { describe, expect, it, vi } from 'vitest';
import { decodeGlyphs, GlyphStore, glyphRanges, glyphUrl, parseSpriteIndex, spriteUrls, type Glyph } from './glyphs.js';
import { lineAnchors, placeGlyphsAlongLine } from './line-labels.js';
import { brunnel, localizedName, localizedTextField, placePriority, roadClass, roadDrawOrder } from './osm.js';
import { CrossTileSymbolIndex, placeSymbols, SymbolFader, type SymbolCandidate } from './symbol-placement.js';
import { DEFAULT_SHAPING, shapeText } from './text-shaping.js';
import { StyleLayer } from './style-layer.js';
import type { FrameView } from '@vibeglobe/core';
import { GlyphSource } from './glyph-source.js';
import { HiddenLabels } from './placed-labels.js';
import { labelColors, LabelPlacer } from './label-placer.js';
import { BUCKET_EXTENT } from './layout-tile.js';
import type { VectorAtlas } from './vector-target.js';

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

  it('keeps a fully shown label shown while it stays placed (TD-01)', () => {
    const fader = new SymbolFader(300);
    fader.update(0, new Set([1]));
    expect(fader.update(300, new Set([1])).get(1)).toBe(1);
    expect(fader.update(400, new Set([1])).get(1)).toBe(1);
    expect(fader.update(500, new Set([1])).get(1)).toBe(1);
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

describe('label placement cost during camera motion (KB-210)', () => {
  it('neither shapes nor styles a label whose anchor is off screen', () => {
    const needed: string[] = [];
    // Glyphs never arrive, so every label the placer shapes asks for its text's glyphs once per frame.
    const glyphs = { need: (_font: string[], text: string) => void needed.push(text), ready: () => false };
    const view = {
      // 10 px per degree of longitude around the screen's center: 0° E is on screen, 144° E far to the right.
      geoToScreen: ({ longitudeDeg }: { longitudeDeg: number }) => ({ xPx: 400 + longitudeDeg * 10, yPx: 300 }),
      camera: { morphFactor: 1 },
    };
    const placer = new LabelPlacer(view, glyphs as unknown as GlyphSource, {} as VectorAtlas);
    const layer = new StyleLayer({ id: 'places', type: 'symbol', source: 's', 'source-layer': 'place' });
    const half = BUCKET_EXTENT / 2;
    const bucket = {
      layerId: 'places',
      features: [
        { id: 1, type: 'Point' as const, properties: {} },
        { id: 2, type: 'Point' as const, properties: {} },
      ],
      labels: [
        { feature: 0, text: 'here', anchor: [half, half] as [number, number] },
        { feature: 1, text: 'there', anchor: [BUCKET_EXTENT * 0.9, half] as [number, number] },
      ],
    };
    const source = {
      layer,
      layerIndex: 0,
      opacity: 1,
      tile: { z: 0, x: 0, y: 0 },
      clip: [0, 0, BUCKET_EXTENT, BUCKET_EXTENT] as const,
      bucket: bucket as never,
      version: 1,
    };
    placer.frame([source], { widthPx: 800, heightPx: 600 } as FrameView, 2, 0);
    expect(needed).toEqual(['here']);
  });
});

describe('label memory over a long session', () => {
  it('forgets the anchors and indexed labels of tiles the view left', () => {
    const glyphs = { need: () => undefined, ready: () => false };
    const view = { geoToScreen: () => ({ xPx: 400, yPx: 300 }), camera: { morphFactor: 1 } };
    const placer = new LabelPlacer(view, glyphs as unknown as GlyphSource, {} as VectorAtlas);
    const layer = new StyleLayer({ id: 'places', type: 'symbol', source: 's', 'source-layer': 'place' });
    const half = BUCKET_EXTENT / 2;
    const bucket = {
      layerId: 'places',
      features: [{ id: 1, type: 'Point' as const, properties: {} }],
      labels: [{ feature: 0, text: 'here', anchor: [half, half] as [number, number] }],
    };
    const source = (x: number) => ({
      layer,
      layerIndex: 0,
      opacity: 1,
      tile: { z: 12, x, y: 0 },
      clip: [0, 0, BUCKET_EXTENT, BUCKET_EXTENT] as const,
      bucket: bucket as never,
      version: 1,
    });
    // A pan across 1000 tiles, four on screen at a time.
    for (let x = 0; x < 1000; x++)
      placer.frame(
        [0, 1, 2, 3].map((d) => source(x + d)),
        { widthPx: 800, heightPx: 600 } as FrameView,
        12,
        x * 16,
      );
    const internals = placer as unknown as { anchors: Map<string, unknown>; index: { size: number } };
    expect(internals.anchors.size).toBeLessThanOrEqual(257);
    expect(internals.index.size).toBeLessThanOrEqual(257);
  });
});

describe('a sprite that fails to load', () => {
  it('stops holding labels back for their icons once it has failed, so their text draws alone', async () => {
    const fetchImpl = (() => Promise.reject(new Error('offline'))) as typeof fetch;
    const source = new GlyphSource(undefined, fetchImpl, () => undefined, {}, undefined);
    expect(source.spriteLoading).toBe(false);
    const loading = source.loadSprite('https://s.test/sprite', 1);
    expect(source.spriteLoading).toBe(true);
    await loading;
    expect(source.spriteLoading).toBe(false);
    expect(source.icon('bus')).toBeUndefined();
  });
});

describe('glyph ranges that fail on the way (TG-04)', () => {
  it('requests a range again after a server or network failure, while a missing range (404) stays empty', async () => {
    vi.useFakeTimers();
    try {
      const answers: (Response | Error)[] = [new Response('fail', { status: 500 }), new Error('reset')];
      const asked: string[] = [];
      const fetchImpl = ((url: string) => {
        asked.push(url);
        const answer = answers.shift() ?? new Response(null, { status: 404 });
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      }) as typeof fetch;
      let changes = 0;
      const source = new GlyphSource(
        'https://g.test/{fontstack}/{range}.pbf',
        fetchImpl,
        () => changes++,
        {},
        undefined,
      );
      const font = ['Noto Sans Regular'];
      source.need(font, 'Via');
      await vi.advanceTimersByTimeAsync(0);
      // The 500 is not taken as an empty range: the labels wait, and the range is asked for again later.
      expect(source.ready(font, 'Via')).toBe(false);
      source.need(font, 'Via');
      expect(asked).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(changes).toBeGreaterThan(0);
      source.need(font, 'Via');
      await vi.advanceTimersByTimeAsync(0);
      expect(asked).toHaveLength(2);
      expect(source.ready(font, 'Via')).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      source.need(font, 'Via');
      await vi.advanceTimersByTimeAsync(0);
      // A 404: the font has no such range; it is not asked for again.
      expect(asked).toHaveLength(3);
      expect(source.ready(font, 'Via')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('requests a range again, past the HTTP cache, when its bytes arrive truncated or corrupted (KB-226)', async () => {
    vi.useFakeTimers();
    try {
      const whole = glyphPbf('Noto Sans Regular', [86, 105, 97]);
      const corrupted = Uint8Array.from(whole);
      // A damaged width (field 3, 10 → 11): the glyph's bitmap no longer matches its size.
      const width = whole.findIndex((byte, i) => byte === 0x18 && whole[i + 1] === 10);
      corrupted[width + 1] = 11;
      const bodies = [whole.slice(0, Math.floor(whole.length / 2)), corrupted, Uint8Array.from(whole)];
      const asked: (RequestInit | undefined)[] = [];
      const fetchImpl = ((_url: string, init?: RequestInit) => {
        asked.push(init);
        return Promise.resolve(new Response(bodies.shift() ?? Uint8Array.from(whole)));
      }) as typeof fetch;
      const source = new GlyphSource(
        'https://g.test/{fontstack}/{range}.pbf',
        fetchImpl,
        () => undefined,
        {},
        undefined,
      );
      const font = ['Noto Sans Regular'];
      for (let i = 0; i < 3; i++) {
        source.need(font, 'Via');
        await vi.advanceTimersByTimeAsync(0);
        // Bytes that do not decode are not taken as the range: the labels wait for it, and it counts as loading.
        if (i < 2) expect([source.ready(font, 'Via'), source.loading]).toEqual([false, 1]);
        await vi.advanceTimersByTimeAsync(5_000);
      }
      expect(asked.map((init) => init?.cache)).toEqual([undefined, 'reload', 'reload']);
      expect([source.ready(font, 'Via'), source.loading]).toEqual([true, 0]);
      expect(source.resolve(86, font)).toBeDefined();
      // A range answered damaged five times is kept as what decoded: its characters fall to the local font.
      bodies.push(corrupted, corrupted, corrupted, corrupted, corrupted);
      for (let i = 0; i < 5; i++) {
        source.need(font, 'Ж');
        await vi.advanceTimersByTimeAsync(5_000);
      }
      expect([source.ready(font, 'Ж'), source.loading]).toEqual([true, 0]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('labels in the page font (F689)', () => {
  it('draws every label locally in the page font, with the weight and style of its font stack, fetching no glyphs', () => {
    const asked: string[] = [];
    const fetchImpl = ((url: string) => {
      asked.push(url);
      return Promise.reject(new Error('offline'));
    }) as typeof fetch;
    const drawn: string[] = [];
    const target = {
      rasterizeGlyphs: (font: string, family: string, codes: readonly number[]) => {
        drawn.push(`${font}|${family}|${codes.join(',')}`);
        return codes.map((id) => ({ id, width: 1, height: 1, left: 0, top: 0, advance: 8, bitmap: [0] }));
      },
    };
    const source = new GlyphSource(
      'https://g.test/{fontstack}/{range}.pbf',
      fetchImpl,
      () => undefined,
      target,
      undefined,
      'system-ui',
    );
    const bold = ['Noto Sans Bold'];
    source.need(bold, 'Ab');
    expect(source.ready(bold, 'Ab')).toBe(true);
    expect(source.ready(['Arial Unicode MS Italic'], 'A')).toBe(true);
    expect(source.ready(['Noto Sans Semibold Italic'], 'A')).toBe(true);
    expect(source.ready(['Noto Sans Regular'], 'A')).toBe(true);
    expect(source.ready(bold, 'b')).toBe(true);
    expect(drawn).toEqual([
      '700|system-ui|65,98',
      'italic 400|system-ui|65',
      'italic 600|system-ui|65',
      '400|system-ui|65',
    ]);
    expect(source.resolve(65, bold)?.fontStack).toBe('Noto Sans Bold');
    expect(asked).toEqual([]);
  });
});

describe('label opacity (KB-245)', () => {
  it('fades the halo with the text', () => {
    const layer = new StyleLayer({
      id: 'names',
      type: 'symbol',
      source: 's',
      'source-layer': 'place',
      paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0, 0, 0, 0.6)', 'text-opacity': 0.5 },
    });
    const colors = labelColors((name) => layer.paint(name, 5));
    expect(colors.fill[3]).toBeCloseTo(0.5);
    expect(colors.halo[3]).toBeCloseTo(0.3);
  });
});

describe('label anchors and hidden labels (F652)', () => {
  // Every character is a 10 × 14 glyph, 12 px apart, always ready, with room in the atlas.
  const glyph = { id: 0, bitmap: new Uint8Array(0), width: 10, height: 14, left: 0, top: -10, advance: 12 };
  const glyphs = {
    need: () => undefined,
    ready: () => true,
    resolve: (code: number) => ({ glyph: { ...glyph, id: code }, fontStack: 'f' }),
    icon: () => undefined,
    spriteLoading: false,
  } as unknown as GlyphSource;
  const atlas = { generation: 0, get: () => ({ x: 0, y: 0, width: 16, height: 20 }) } as unknown as VectorAtlas;
  // 10 px per degree around the screen's center.
  const view = {
    geoToScreen: (p: { longitudeDeg: number; latitudeDeg: number }) => ({
      xPx: 400 + p.longitudeDeg * 10,
      yPx: 300 - p.latitudeDeg * 10,
    }),
    camera: { morphFactor: 1 },
  };
  const half = BUCKET_EXTENT / 2;
  const symbols = (id: string, layerIndex: number, labels: readonly { text: string; iso: string; dx: number }[]) => ({
    layer: new StyleLayer({ id, type: 'symbol', source: 's', 'source-layer': 'place' }),
    layerIndex,
    opacity: 1,
    tile: { z: 0, x: 0, y: 0 },
    clip: [0, 0, BUCKET_EXTENT, BUCKET_EXTENT] as const,
    bucket: {
      layerId: id,
      features: labels.map((l, i) => ({ id: i, type: 'Point' as const, properties: { iso_a2: l.iso } })),
      labels: labels.map((l, i) => ({ feature: i, text: l.text, anchor: [half + l.dx, half] as [number, number] })),
    } as never,
    version: 1,
  });
  // A city's name under Italy's, on a lower layer: Italy's name takes its room.
  const sources = [
    symbols('countries', 1, [
      { text: 'IT', iso: 'IT', dx: 100 },
      { text: 'FR', iso: 'FR', dx: -300 },
    ]),
    symbols('cities', 0, [{ text: 'Roma', iso: 'IT', dx: 100 }]),
  ];
  const frameView = { widthPx: 800, heightPx: 600 } as FrameView;

  it('reads where the style placed the labels of a layer, on the ground and on screen, by a feature property', () => {
    const placer = new LabelPlacer(view, glyphs, atlas);
    placer.frame(sources, frameView, 2, 0);
    const anchors = placer.placedBy('countries', 'iso_a2');
    expect([...anchors.keys()]).toEqual(['IT', 'FR']);
    const italy = anchors.get('IT');
    expect(italy?.position.longitudeDeg).toBeCloseTo(((half + 100) / BUCKET_EXTENT) * 360 - 180, 9);
    expect(italy?.position.latitudeDeg).toBeCloseTo(0, 9);
    expect(italy?.screenPoint).toEqual(view.geoToScreen(italy?.position ?? { longitudeDeg: NaN, latitudeDeg: NaN }));
    expect(placer.placedBy('cities', 'iso_a2').size).toBe(0);
  });

  it('keeps hidden labels placed, taking their room, without drawing them, and fades them back in', () => {
    const hidden = new HiddenLabels();
    const placer = new LabelPlacer(view, glyphs, atlas, undefined, hidden);
    const glyphsDrawn = (nowMs: number) => placer.frame(sources, frameView, 2, nowMs).quads.quads;
    glyphsDrawn(0);
    expect(glyphsDrawn(1000)).toBe(4);
    hidden.set('countries', { property: 'iso_a2', values: ['IT'] });
    // Italy's name fades out over the label fade, and Rome's stays out of its room.
    expect(glyphsDrawn(1100)).toBe(4);
    expect(glyphsDrawn(2000)).toBe(2);
    expect([...placer.placedBy('countries', 'iso_a2').keys()]).toEqual(['IT', 'FR']);
    expect(placer.placed().map((label) => label.text)).toEqual(['FR']);
    hidden.set('countries', true);
    expect(glyphsDrawn(3000)).toBe(0);
    expect(placer.placedBy('countries', 'iso_a2').size).toBe(2);
    hidden.set('countries', false);
    const fadingIn = placer.frame(sources, frameView, 2, 3100).quads;
    expect(fadingIn.quads).toBe(4);
    expect(fadingIn.params[2]).toBeCloseTo(1 / 3, 6);
  });
});
