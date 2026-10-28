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
      expect(r.termsReadDate).toBe('2026-10-26');
    }
    // No service is both included and excluded.
    const excluded = new Set(EXCLUDED_SOURCES.map((s) => s.id));
    expect(EUROPE_ORTHOPHOTOS.filter((r) => excluded.has(r.id))).toEqual([]);
    const orthophotos = await europeOrthophotos({ exclude: ['de-nw-dop'], onlineMaxLevel: { 'cz-cuzk-ortofoto': 18 } });
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

  it('fades the orthophotos in over the last package level, matching its tones, with soft borders, all on with one option (F636, F637)', async () => {
    const { layers } = await europeOrthophotos();
    for (const layer of layers) {
      expect(layer).toMatchObject({ harmonize: 'below', fadeIn: { fromZoom: 11, toZoom: 12 } });
      // Every service up to its own deepest level, none cut by a default.
      expect(layer.sources[0]?.maxLevel).toBe(EUROPE_ORTHOPHOTOS.find((r) => r.id === layer.id)?.maxLevel);
    }
    const options = await withAllOnlineSources({ farLevels: 4 });
    expect(options.farLevels).toBe(4);
    expect(options.orthophotos?.layers.map((l) => l.id)).toEqual(EUROPE_ORTHOPHOTOS.map((r) => r.id));
  });
});
