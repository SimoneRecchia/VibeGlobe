import type { TileSource } from '@vibeglobe/core';
import { xyzImagery } from '@vibeglobe/sources';
import { describe, expect, it } from 'vitest';
import { europeOpen, type OfflineWrapper } from './europe.js';
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
    expect(preset.baseMaps.map((b) => b.id)).toEqual(['satellite', 'hybrid', 'map', 'relief']);
    expect(preset.overlays.map((o) => o.id)).toEqual(['labels', 'roads', 'buildings', 'terrain']);
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
      expect(s.termsReadDate).toBe('2026-10-26');
    }
    expect(preset.excluded.map((s) => s.id)).toContain('basemap-at');
    // Satellite: the package's composite, from the package only; terrain: the package, then online.
    const satellite = preset.baseMaps[0]?.imagery[0]?.sources ?? [];
    expect(satellite.map((s) => s.id)).toEqual(['europe-satellite']);
    expect(offline.tiers.get('europe-satellite')).toBe('package');
    expect(offline.tiers.get('europe-terrain')).toBe('all');
    // Online terrain covers land only: a tile over the Alps is asked for, one over the open sea is not.
    expect(preset.terrain?.request(ALPS, out)).toMatchObject({ url: 'https://tiles.mapterhorn.com/8/135/90.webp' });
    expect(preset.terrain?.request(SEA, out)).toBe('noData');
    expect(satellite[0]?.request(SEA, out)).not.toBe('noData');
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
    expect(preset.baseMaps[0]?.imagery[0]?.sources.map((s) => s.id)).toEqual(['customer']);
    expect(preset.sources.map((s) => s.id)).toEqual(['customer', 'europe-terrain']);
    expect(() => europeOpen({ packageManifestUrl: 'https://app.test/manifest.json' })).toThrow(/offline engine/);
    expect(
      europeOpen({ onlineMaxLevel: { openfreemap: 10 } }).styleFor(STYLE, 'map', [])?.sources['openmaptiles'],
    ).toMatchObject({
      maxzoom: 10,
    });
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
    // The hillshade: the package's terrain up to level 12, Mapterhorn beyond.
    expect(hybrid('https://tiles.mapterhorn.com/12/2160/1440.webp')).toBe(
      'https://app.test/maps/europe/europe-terrain/12/2160/1440.webp',
    );
    expect(hybrid('https://tiles.mapterhorn.com/13/4320/2880.webp')).toBe(
      'https://tiles.mapterhorn.com/13/4320/2880.webp',
    );
    // Offline: every file from the package and its mirror of the style's files; online: every file unchanged.
    const offline = preset.transformUrl('offline');
    expect(offline(vectors(13, 4320, 2880))).toBe('https://app.test/maps/europe/europe-vectors/13/4320/2880.pbf');
    expect(offline('https://tiles.openfreemap.org/fonts/Noto/0-255.pbf')).toBe(
      'https://app.test/maps/europe/openfreemap/fonts/Noto/0-255.pbf',
    );
    expect(preset.transformUrl('online')(vectors(12, 2160, 1440))).toBe(vectors(12, 2160, 1440));
  });

  it('composes one style per selection: the whole map, overlays without a background, relief with its hillshade', () => {
    const preset = europeOpen();
    const ids = (
      baseId: 'satellite' | 'hybrid' | 'map' | 'relief',
      overlays: ('labels' | 'roads' | 'buildings')[] = [],
    ) => preset.styleFor(STYLE, baseId, overlays)?.layers.map((l) => l.id);
    expect(ids('satellite')).toBeUndefined();
    expect(ids('hybrid')).toEqual(['road', 'road-name', 'border', 'city']);
    expect(ids('map')).toEqual(STYLE.layers.map((l) => l.id));
    expect(ids('relief', ['labels'])).toEqual(['europe-relief-background', 'europe-hillshade', 'border', 'city']);
    expect(ids('satellite', ['buildings'])).toEqual(['europe-buildings-3d']);
    expect(preset.styleFor(STYLE, 'relief', [])?.sources['europe-hillshade']).toMatchObject({
      type: 'raster-dem',
      encoding: 'terrarium',
    });
  });
});
