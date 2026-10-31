import type { TileSource } from '@vibeglobe/core';
import { xyzImagery } from '@vibeglobe/sources';
import { featureFilter, type FilterSpecification } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import { europeOpen, onlineFade, type OfflineWrapper } from './europe.js';
import type { StyleJson } from './styles.js';

/** Records how each source is wrapped, as the offline engine would wrap it. */
function fakeOffline(): OfflineWrapper & { tiers: Map<string, string | undefined> } {
  const tiers = new Map<string, string | undefined>();
  return {
    tiers,
    source<S extends TileSource>(source: S, options: { tiers?: string }): S {
      tiers.set(source.id, options.tiers);
      return source;
    },
  };
}

const out = { url: '', hostIndex: 0 };
const tile = (level: number, x: number, y: number) => ({ root: 0 as const, level, x, y });
// Level 8 tiles of Web Mercator: over the Alps (about 10° E, 46.5° N), and over the Tyrrhenian Sea (about 11° E, 40° N).
const ALPS = tile(8, 135, 90);
const SEA = tile(8, 135, 97);

/** A small style in the OpenMapTiles schema, the shape OpenFreeMap's styles have. */
const STYLE: StyleJson = {
  version: 8,
  glyphs: 'https://fonts.test/{fontstack}/{range}.pbf',
  sources: { openmaptiles: { type: 'vector', url: 'https://tiles.test/planet' } },
  layers: [
    { id: 'background', type: 'background' },
    { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water' },
    { id: 'road', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation' },
    { id: 'road-name', type: 'symbol', source: 'openmaptiles', 'source-layer': 'transportation_name' },
    { id: 'border', type: 'line', source: 'openmaptiles', 'source-layer': 'boundary' },
    { id: 'building', type: 'fill', source: 'openmaptiles', 'source-layer': 'building' },
    { id: 'city', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place' },
  ],
};

describe('europeOpen (F613)', () => {
  it('builds every map type from free sources with their terms, online sources on land and the sea from the package', () => {
    const offline = fakeOffline();
    const preset = europeOpen({ packageManifestUrl: 'https://app.test/maps/europe/manifest.json', offline });
    expect(preset.baseMaps.map((b) => b.id)).toEqual(['satellite', 'hybrid', 'map', 'landscape', 'relief']);
    expect(preset.overlays.map((o) => o.id)).toEqual([
      'labels',
      'roads',
      'buildings',
      'borders',
      'countries',
      'seas',
      'terrain',
    ]);
    // Every source with its licence, exact attribution and the day its terms were read.
    expect(preset.sources.map((s) => s.id)).toEqual([
      'europe-satellite',
      'europe-terrain',
      'copernicus-glo30',
      'openfreemap',
    ]);
    for (const s of preset.sources) {
      expect(s.license).not.toBe('');
      expect(s.attribution[0]?.text).not.toBe('');
      expect(s.termsReadDate).toBe(s.id === 'nasa-gibs-blue-marble' ? '2026-10-27' : '2026-10-26');
    }
    expect(preset.excluded.map((s) => s.id)).toContain('no-norge-i-bilder');
    // Satellite: the package's composite over the globe's base image, from the package only, with its water keyed out
    // (F639); no Blue Marble with a package. Terrain: the package, then online.
    const [composite] = preset.baseMaps[0]?.imagery ?? [];
    expect(preset.baseMaps[0]?.imagery.length).toBe(1);
    const satellite = composite?.sources ?? [];
    expect(satellite.map((s) => s.id)).toEqual(['europe-satellite']);
    expect(offline.tiers.get('europe-satellite')).toBe('package');
    expect(offline.tiers.has('nasa-gibs-blue-marble')).toBe(false);
    expect(offline.tiers.get('europe-terrain')).toBe('all');
    // Online terrain covers land only: a tile over the Alps is asked for, one over the open sea is not.
    expect(preset.terrain?.request(ALPS, out)).toMatchObject({ url: 'https://tiles.mapterhorn.com/8/135/90.webp' });
    expect(preset.terrain?.request(SEA, out)).toBe('noData');
    // The package's satellite tiles are asked for within its box, land and sea (its water keyed out), not beyond it: a
    // level 8 tile over the Atlantic at 40° W (F639).
    expect(satellite[0]?.request(SEA, out)).not.toBe('noData');
    expect(satellite[0]?.request(ALPS, out)).not.toBe('noData');
    expect(satellite[0]?.request(tile(8, 99, 95), out)).toBe('noData');
    expect(preset.packageManifestUrl).toBe('https://app.test/maps/europe/manifest.json');
    expect(preset.styleUrl('offline')).toBe('https://app.test/maps/europe/openfreemap/styles/liberty');
    expect(preset.styleUrl('online')).toBe('https://tiles.openfreemap.org/styles/liberty');
  });

  it("lowers an online level, leaves out a source, adds the app's own, and is online only without a package", () => {
    const own = xyzImagery({ id: 'customer', url: 'https://customer.test/{z}/{x}/{y}.jpg' });
    const preset = europeOpen({
      onlineMaxLevel: { 'europe-terrain': 12, openfreemap: 10 },
      exclude: ['openfreemap'],
      addSources: [
        {
          source: own,
          record: {
            id: 'customer',
            name: 'Customer imagery',
            kind: 'imagery',
            tiers: 'network',
            license: 'Customer contract',
            termsUrl: 'https://customer.test/terms',
            termsReadDate: '2026-10-26',
            attribution: [{ text: '© Customer' }],
            minLevel: 0,
            maxLevel: 19,
            coverage: 'europe-land',
          },
        },
      ],
    });
    expect(preset.terrain?.maxLevel).toBe(12);
    expect(preset.baseMaps.map((b) => b.id)).toEqual(['satellite', 'hybrid', 'relief']);
    expect(preset.overlays.map((o) => o.id)).toEqual(['terrain']);
    expect(preset.baseMaps[0]?.imagery.map((layer) => layer.sources.map((s) => s.id))).toEqual([
      ['nasa-gibs-blue-marble'],
      ['customer'],
    ]);
    expect(preset.sources.map((s) => s.id)).toEqual(['customer', 'nasa-gibs-blue-marble', 'europe-terrain']);
    expect(() => europeOpen({ packageManifestUrl: 'https://app.test/manifest.json' })).toThrow(/offline engine/);
    expect(
      europeOpen({ onlineMaxLevel: { openfreemap: 10 } }).styleFor(STYLE, 'map', [])?.sources['openmaptiles'],
    ).toMatchObject({
      maxzoom: 10,
    });
  });

  it("keys the package's water out with a soft edge over the sea, so the base image shows there at every level (KB-231)", () => {
    const preset = europeOpen({
      packageManifestUrl: 'https://app.test/maps/europe/manifest.json',
      offline: fakeOffline(),
    });
    const worldCover = preset.baseMaps[0]?.imagery[0]?.sources[0];
    expect(worldCover?.transparent).toBe(true);
    // Over the open sea (level 8) the water's pixels are keyed out over the whole tile and the others stay (KB-302); a
    // tile across the package box's edge (level 8 at 32° W, 50° N) fades out beyond it over 12 pixels (F639).
    expect(worldCover?.tileMask?.(SEA)?.sea?.ringEnds.length).toBe(0);
    expect(Array.from(worldCover?.tileMask?.(SEA)?.points ?? [])).toEqual([0, 0, 1, 0, 1, 1, 0, 1]);
    expect(worldCover?.tileMask?.(tile(8, 105, 86))).toMatchObject({
      featherPx: 12,
      sea: { ringEnds: new Uint32Array() },
    });
  });

  it("keys the package's sea out at every level, its real water too, and keeps the land's lakes and shadows (KB-302)", () => {
    const worldCover = europeOpen({
      packageManifestUrl: 'https://app.test/maps/europe/manifest.json',
      offline: fakeOffline(),
    }).baseMaps[0]?.imagery[0]?.sources[0];
    // A level 10 tile of the coast at Ancona (13.5° E, 43.6° N), where the package's real water ends in rectangles:
    // the land's outline, its water fading back in over 4 km inside it (36.2 pixels of this tile).
    const coast = worldCover?.tileMask?.(tile(10, 550, 373))?.sea;
    expect(coast?.ringEnds.length).toBeGreaterThan(0);
    expect(coast?.featherPx).toBeCloseTo(36.2, 1);
    // Deep inside France (level 8, about 2° E, 46.5° N) nothing is keyed: its lakes and shadows stay.
    expect(worldCover?.tileMask?.(tile(8, 129, 90))).toBeUndefined();
  });

  it('hands the levels above the package to the online sources an app adds, and magnifies level 11 without them (F632)', () => {
    const fine = xyzImagery({ id: 'fine', url: 'https://fine.test/{z}/{x}/{y}.jpg', minLevel: 12, maxLevel: 19 });
    const record = {
      id: 'fine',
      name: 'Fine imagery',
      kind: 'imagery' as const,
      tiers: 'network' as const,
      license: 'CC BY 4.0',
      termsUrl: 'https://fine.test/terms',
      termsReadDate: '2026-10-28',
      attribution: [{ text: '© Fine' }],
      minLevel: 12,
      maxLevel: 19,
      coverage: 'europe-land' as const,
    };
    const manifest = { packageManifestUrl: 'https://app.test/maps/europe/manifest.json' };
    const preset = europeOpen({ ...manifest, offline: fakeOffline(), addSources: [{ source: fine, record }] });
    const imagery = preset.baseMaps[0]?.imagery ?? [];
    expect(imagery.map((layer) => layer.id)).toEqual(['satellite', 'satellite-online']);
    const worldCover = imagery[0]?.sources[0];
    const first = imagery[1]?.sources[0];
    // The package serves up to its level 11, the added source from 12, in a layer of its own above, to its own
    // deepest level, fading in over level 12 to 13 (F636) in its own colors (F638).
    expect(first?.request(tile(11, 1080, 720), out)).toBe('noData');
    expect(worldCover?.request(tile(11, 1080, 720), out)).not.toBe('noData');
    expect(first?.request(tile(13, 4320, 2880), out)).toMatchObject({ url: 'https://fine.test/13/4320/2880.jpg' });
    expect(first?.maxLevel).toBe(19);
    expect(worldCover?.request(tile(13, 4320, 2880), out)).toBe('noData');
    expect(imagery[1]).toMatchObject({ harmonize: false, fadeIn: { fromZoom: 11, toZoom: 12 } });
    // Without it, nothing serves above level 11: the engine draws the package's level 11 tiles magnified.
    const alone = europeOpen({ ...manifest, offline: fakeOffline() }).baseMaps[0]?.imagery ?? [];
    expect(alone.map((layer) => layer.sources.map((s) => s.maxLevel))).toEqual([[11]]);
  });

  it('shows the base image far away, fades the package in by zoom with tones matched only at the lowest levels, the Blue Marble only online (F636, F638, F639)', () => {
    const manifest = { packageManifestUrl: 'https://app.test/maps/europe/manifest.json', offline: fakeOffline() };
    const layers = europeOpen(manifest).baseMaps[0]?.imagery ?? [];
    // Levels 0–4: the globe's base image alone; WorldCover over level 5 to 6, its tones matched to the base image's in
    // full to level 6, fading to its own by level 9.
    expect(layers.map((l) => [l.id, l.fadeIn, l.harmonize, l.harmonizeFade])).toEqual([
      ['satellite', { fromZoom: 4, toZoom: 5 }, 'below', { fromZoom: 5, toZoom: 8 }],
    ]);
    const farther = europeOpen({ ...manifest, farLevels: 6 }).baseMaps[0]?.imagery ?? [];
    expect(farther.map((l) => l.fadeIn)).toEqual([{ fromZoom: 6, toZoom: 7 }]);
    expect(farther[0]?.sources[0]?.minLevel).toBe(7);
    // Online only, the Blue Marble fades in over the base image, every level kept for the horizon's coarser tiles.
    const online = europeOpen().baseMaps[0]?.imagery ?? [];
    expect(online.map((l) => [l.id, l.fadeIn, l.harmonize])).toEqual([
      ['satellite-base', { fromZoom: 3.5, toZoom: 4 }, false],
    ]);
    expect(online[0]?.sources[0]?.minLevel).toBe(0);
  });

  it("reads the package's satellite imagery to its own deepest level, the orthophotos still fading in from 12 (F662)", () => {
    const manifest = { packageManifestUrl: 'https://app.test/maps/europe/manifest.json', offline: fakeOffline() };
    const satellite = (levels?: { imagery: number }) =>
      europeOpen({ ...manifest, ...(levels ? { packageLevels: levels } : {}) }).baseMaps[0]?.imagery[0]?.sources[0];
    expect(satellite()?.maxLevel).toBe(11);
    const deep = satellite({ imagery: 13 });
    expect(deep?.maxLevel).toBe(13);
    // Level 13 over the Po valley (9.2° E, 45.1° N) comes from the package; beyond 13 its tile is magnified.
    expect(deep?.request({ root: 0, level: 13, x: 4305, y: 2943 }, { url: '', hostIndex: 0 })).toMatchObject({
      url: 'https://app.test/maps/europe/imagery/13/4305/2943.jpg',
    });
    expect(onlineFade()).toEqual({ fromZoom: 11, toZoom: 12 });
  });

  it('reads vector and hillshade tiles from the package up to its levels and over the sea, online beyond on land', () => {
    const preset = europeOpen({
      packageManifestUrl: 'https://app.test/maps/europe/manifest.json',
      offline: fakeOffline(),
      packageLevels: { vectors: 12 },
    });
    const vectors = (z: number, x: number, y: number) => `https://tiles.openfreemap.org/planet/v1/${z}/${x}/${y}.pbf`;
    const hybrid = preset.transformUrl('hybrid');
    // Level 13 over the Alps is beyond the package: online; over the Tyrrhenian Sea: the package (or its ancestor).
    expect(hybrid(vectors(12, 2160, 1440))).toBe('https://app.test/maps/europe/europe-vectors/12/2160/1440.pbf');
    expect(hybrid(vectors(13, 4320, 2880))).toBe(vectors(13, 4320, 2880));
    expect(hybrid(vectors(13, 4320, 3104))).toBe('https://app.test/maps/europe/europe-vectors/13/4320/3104.pbf');
    // Outside the package's region, and the style's own files, stay online.
    expect(hybrid(vectors(13, 2275, 3000))).toBe(vectors(13, 2275, 3000));
    expect(hybrid('https://tiles.openfreemap.org/fonts/Noto/0-255.pbf')).toBe(
      'https://tiles.openfreemap.org/fonts/Noto/0-255.pbf',
    );
    // The hillshade: the package's terrain up to level 11 (the owner's package level, 2026-10-27), Mapterhorn beyond.
    expect(hybrid('https://tiles.mapterhorn.com/11/1080/720.webp')).toBe(
      'https://app.test/maps/europe/europe-terrain/11/1080/720.webp',
    );
    expect(hybrid('https://tiles.mapterhorn.com/12/2160/1440.webp')).toBe(
      'https://tiles.mapterhorn.com/12/2160/1440.webp',
    );
    // Offline: every file from the package and its mirror of the style's files; online: every file unchanged.
    const offline = preset.transformUrl('offline');
    expect(offline(vectors(13, 4320, 2880))).toBe('https://app.test/maps/europe/europe-vectors/13/4320/2880.pbf');
    expect(offline('https://tiles.openfreemap.org/fonts/Noto/0-255.pbf')).toBe(
      'https://app.test/maps/europe/openfreemap/fonts/Noto/0-255.pbf',
    );
    expect(preset.transformUrl('online')(vectors(12, 2160, 1440))).toBe(vectors(12, 2160, 1440));
  });

  it('composes one style per selection: a political map, overlays without a background, relief under the map (KB-216)', () => {
    const preset = europeOpen();
    const ids = (
      baseId: 'satellite' | 'hybrid' | 'map' | 'relief',
      overlays: ('labels' | 'roads' | 'buildings')[] = [],
    ) => preset.styleFor(STYLE, baseId, overlays)?.layers.map((l) => l.id);
    expect(ids('satellite')).toBeUndefined();
    expect(ids('hybrid')).toEqual(['road', 'road-name', 'border', 'city']);
    // Map: neutral land, water, borders and names on the style's data, no land cover or buildings; roads off unless
    // their overlay is on, then below the borders and names.
    const political = [
      'political-land',
      'political-water',
      'political-rivers',
      'political-region-borders',
      'political-country-borders',
      'political-water-names',
      'political-villages',
      'political-towns',
      'political-cities',
      'political-regions',
      'political-countries',
    ];
    expect(ids('map')).toEqual(political);
    expect(ids('map', ['roads', 'labels'])).toEqual([
      ...political.slice(0, 3),
      'road',
      'road-name',
      ...political.slice(3),
    ]);
    // Relief: the political map over a light tint by elevation and a hillshade, under its water.
    expect(ids('relief')).toEqual(['political-land', 'europe-relief-tint', 'europe-hillshade', ...political.slice(1)]);
    expect(ids('satellite', ['buildings'])).toEqual(['europe-buildings-3d']);
    expect(preset.styleFor(STYLE, 'relief', [])?.sources['europe-hillshade']).toMatchObject({
      type: 'raster-dem',
      encoding: 'terrarium',
    });
    // Without vector tiles the relief stands on the land color alone.
    expect(
      europeOpen({ exclude: ['openfreemap'] })
        .styleFor(STYLE, 'relief', [])
        ?.layers.map((l) => l.id),
    ).toEqual(['europe-relief-background', 'europe-relief-tint', 'europe-hillshade']);
  });

  it("fills the polar caps like the surface around them: Natural Earth's colors in Satellite and Hybrid, the map's colors in Map and Relief (KB-214)", () => {
    const preset = europeOpen();
    // NASA's Blue Marble from GIBS's EPSG:4326 WMS, one image per Web Mercator tile (KB-232), to its level 8.
    const blueMarble = preset.baseMaps[0]?.imagery[0]?.sources.at(-1);
    expect(blueMarble?.tiling.crs).toBe('EPSG:3857');
    expect(blueMarble?.maxLevel).toBe(8);
    // A level 6 tile across 45° N (0° to 5.6° E, 41° to 45.1° N) is asked for at its own extent, latitude first, its
    // rows linear in latitude.
    expect(blueMarble?.latitudeRows).toBe(true);
    expect((blueMarble?.request(tile(6, 32, 23), out) as { url: string }).url).toMatch(
      /LAYERS=BlueMarble_ShadedRelief_Bathymetry.*CRS=EPSG%3A4326.*BBOX=40\.979\d*,0,45\.089\d*,5\.625$/,
    );
    for (const id of ['satellite', 'hybrid'])
      expect(preset.baseMaps.find((b) => b.id === id)?.polarCapColors).toEqual({ north: '#7aacd0', south: '#eef1f6' });
    for (const id of ['map', 'relief'])
      expect(preset.baseMaps.find((b) => b.id === id)?.polarCapColors).toEqual({ north: '#a9cfe8', south: '#f2efe9' });
  });

  it('shows roads by class from their levels, motorways from 6 to the rest from 14, and road names from 13 (F626)', () => {
    const style = europeOpen().styleFor(STYLE, 'map', ['roads']);
    const road = style?.layers.find((l) => l.id === 'road');
    const names = style?.layers.find((l) => l.id === 'road-name');
    expect(road?.['minzoom']).toBe(6);
    expect(names?.['minzoom']).toBe(13);
    const filter = featureFilter(road?.['filter'] as FilterSpecification, 'layers.road.filter');
    const shown = (zoom: number) =>
      ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'path', 'rail'].filter((kind) =>
        filter.filter({ zoom }, { type: 2, properties: { class: kind } } as never),
      );
    expect(shown(6)).toEqual(['motorway']);
    expect(shown(8)).toEqual(['motorway']);
    expect(shown(9)).toEqual(['motorway', 'trunk', 'primary']);
    expect(shown(11)).toEqual(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
    expect(shown(13)).toEqual(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor']);
    expect(shown(14)).toHaveLength(9);
    // Hybrid's roads follow the same levels.
    expect(
      europeOpen()
        .styleFor(STYLE, 'hybrid', [])
        ?.layers.find((l) => l.id === 'road')?.['minzoom'],
    ).toBe(6);
  });
});
