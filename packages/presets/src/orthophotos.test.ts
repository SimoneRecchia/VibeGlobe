import { describe, expect, it } from 'vitest';
import { europeOpen } from './europe.js';
import { EUROPE_ORTHOPHOTOS, europeOrthophotos, withAllOnlineSources } from './orthophotos.js';
import { EXCLUDED_SOURCES } from './sources.js';

const out = { url: '', hostIndex: 0 };
const tile = (level: number, x: number, y: number) => ({ root: 0 as const, level, x, y });

describe('national and regional orthophotos (ADR 0182, F618)', () => {
  it('builds one layer per service, clipped to its borders, above the satellite composite, with its terms', async () => {
    for (const r of EUROPE_ORTHOPHOTOS) {
      expect(r.license).not.toBe('');
      expect(r.attribution[0]?.text).not.toBe('');
      expect(['2026-10-26', '2026-10-31']).toContain(r.termsReadDate);
    }
    // No service is both included and excluded.
    const excluded = new Set(EXCLUDED_SOURCES.map((s) => s.id));
    expect(EUROPE_ORTHOPHOTOS.filter((r) => excluded.has(r.id))).toEqual([]);
    const orthophotos = await europeOrthophotos({
      exclude: ['de-nw-dop'],
      onlineMaxLevel: { 'cz-cuzk-ortofoto': 18 },
      keys: { 'fi-mml': 'key' },
    });
    expect(orthophotos.layers).toHaveLength(EUROPE_ORTHOPHOTOS.length - 1);
    const austria = orthophotos.layers.find((l) => l.id === 'basemap-at-orthofoto')?.sources[0];
    // Level 12 over Vienna (16.37° E, 48.21° N) is asked for, rows before columns; over Munich it is not.
    expect(austria?.request(tile(12, 2234, 1420), out)).toMatchObject({
      url: 'https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/12/1420/2234.jpeg',
    });
    expect(austria?.request(tile(12, 2179, 1421), out)).toBe('noData');
    expect(austria?.transparent).toBe(true);
    expect(orthophotos.layers.find((l) => l.id === 'cz-cuzk-ortofoto')?.sources[0]?.maxLevel).toBe(18);
    const preset = europeOpen({ orthophotos });
    const satellite = preset.baseMaps.find((b) => b.id === 'satellite')?.imagery.map((l) => l.id);
    expect(satellite?.slice(-orthophotos.layers.length)).toEqual(orthophotos.layers.map((l) => l.id));
    expect(preset.sources.map((s) => s.id)).toContain('basemap-at-orthofoto');
  });

  it('asks for no orthophoto tile from far away, and counts white tiles as no data (KB-215)', async () => {
    const { layers } = await europeOrthophotos();
    // Over Évora (7.91° W, 38.57° N): level 6 is the satellite composite's, level 12 the orthophoto's.
    const portugal = layers.find((l) => l.id === 'pt-dgt-ortos2025')?.sources[0];
    expect(portugal?.request(tile(6, 30, 24), out)).toBe('noData');
    expect(portugal?.request(tile(12, 1958, 1573), out)).toMatchObject({ url: expect.stringContaining('ortos2025') });
    for (const layer of layers) {
      const source = layer.sources[0];
      expect(source?.minLevel).toBe(12);
      expect(source?.blankTile?.rgb).toEqual([255, 255, 255]);
    }
  });

  it('fades the orthophotos in over the last package level, in their own colors, with soft borders, all on with one option (F636, F637, F638)', async () => {
    const { layers } = await europeOrthophotos();
    for (const layer of layers) {
      expect(layer).toMatchObject({ harmonize: false, fadeIn: { fromZoom: 11, toZoom: 12 } });
      // Every service up to its own deepest level, none cut by a default.
      expect(layer.sources[0]?.maxLevel).toBe(EUROPE_ORTHOPHOTOS.find((r) => r.id === layer.id)?.maxLevel);
    }
    const options = await withAllOnlineSources({ farLevels: 4 }, { keys: { 'fi-mml': 'key' } });
    expect(options.farLevels).toBe(4);
    expect(options.orthophotos?.layers.map((l) => l.id)).toEqual(EUROPE_ORTHOPHOTOS.map((r) => r.id));
  });

  it('covers France, Spain, the Netherlands, Belgium, Luxembourg, Alto Adige, four Länder, Finland, Estonia, Poland and Croatia, each within its borders, to its own level (F661)', async () => {
    const { layers } = await europeOrthophotos({ keys: { 'fi-mml': 'app-key' } });
    /** The level-14 tile at a position. */
    const at = (lonDeg: number, latDeg: number) => {
      const n = 2 ** 14;
      const lat = (latDeg * Math.PI) / 180;
      const y = Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n);
      return tile(14, Math.floor(((lonDeg + 180) / 360) * n), y);
    };
    const places: [string, number, number, string][] = [
      ['ign-bd-ortho', 2.35, 48.86, 'data.geopf.fr'],
      ['pnoa', -3.7, 40.42, 'www.ign.es/wmts/pnoa-ma'],
      ['pdok-luchtfoto', 4.9, 52.37, 'service.pdok.nl'],
      ['be-vlg-omw', 3.72, 51.05, 'geo.api.vlaanderen.be'],
      ['be-wal-ortho-last', 4.87, 50.47, 'geoservices.wallonie.be'],
      ['lu-act-ortho', 6.13, 49.61, 'wmts.geoportail.lu'],
      ['alto-adige-2023', 11.35, 46.5, 'geoservices.buergernetz.bz.it'],
      ['de-by-dop20', 11.58, 48.14, 'geoservices.bayern.de'],
      ['de-he-dop20', 8.68, 50.11, 'gds-srv.hessen.de'],
      ['de-sn-dop20', 13.74, 51.05, 'geodienste.sachsen.de'],
      ['de-hh-dop20', 10.0, 53.55, 'geodienste.hamburg.de'],
      ['fi-mml', 24.94, 60.17, 'avoin-karttakuva.maanmittauslaitos.fi'],
      ['ee-maaamet', 24.75, 59.44, 'kaart.maaamet.ee'],
      ['pl-geoportal-orto', 21.01, 52.23, 'mapy.geoportal.gov.pl'],
      ['hr-dgu-dof', 15.98, 45.81, 'geoportal.dgu.hr'],
    ];
    for (const [id, lon, lat, host] of places) {
      const source = layers.find((l) => l.id === id)?.sources[0];
      expect(source?.request(at(lon, lat), { ...out }), id).toMatchObject({ url: expect.stringContaining(host) });
      // Rome is outside every one of them.
      expect(source?.request(at(12.5, 41.9), { ...out }), id).toBe('noData');
      expect(source?.maxLevel).toBe(EUROPE_ORTHOPHOTOS.find((r) => r.id === id)?.maxLevel);
    }
    // Flanders' service is not asked for Wallonia's tiles, nor Wallonia's for Flanders'.
    const flanders = layers.find((l) => l.id === 'be-vlg-omw')?.sources[0];
    const wallonia = layers.find((l) => l.id === 'be-wal-ortho-last')?.sources[0];
    expect(flanders?.request(at(4.87, 50.47), { ...out })).toBe('noData');
    expect(wallonia?.request(at(3.72, 51.05), { ...out })).toBe('noData');
    // Every service of the second reading has its terms, and none is also listed as excluded.
    const second = EUROPE_ORTHOPHOTOS.filter((r) => r.termsReadDate === '2026-10-31');
    expect(second.map((r) => r.id).sort()).toEqual(places.map(([id]) => id).sort());
  });

  it("uses a service that needs a key only with the application's own key, sent as its parameter (F661)", async () => {
    const without = await europeOrthophotos();
    expect(without.layers.map((l) => l.id)).not.toContain('fi-mml');
    expect(without.sources.map((s) => s.id)).not.toContain('fi-mml');
    const withKey = await europeOrthophotos({ keys: { 'fi-mml': 'a b&c' } });
    const finland = withKey.layers.find((l) => l.id === 'fi-mml')?.sources[0];
    // Level 14 over Helsinki.
    expect(finland?.request(tile(14, 9327, 4742), { ...out })).toMatchObject({
      url: 'https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts/1.0.0/ortokuva/default/WGS84_Pseudo-Mercator/14/4742/9327.jpg?api-key=a+b%26c',
    });
  });

  it('passes every orthophoto through the offline engine as a network source, so an offline mode never asks for one (KB-291)', async () => {
    const orthophotos = await europeOrthophotos();
    const tiers = new Map<string, string | undefined>();
    const offline = {
      source<S extends { id: string }>(source: S, options: { tiers?: string }): S {
        tiers.set(source.id, options.tiers);
        return source;
      },
    };
    europeOpen({ orthophotos, offline });
    for (const layer of orthophotos.layers) expect(tiers.get(layer.id ?? ''), layer.id).toBe('network');
  });
});
