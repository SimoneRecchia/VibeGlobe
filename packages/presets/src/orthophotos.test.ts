import { describe, expect, it } from 'vitest';
import { europeOpen } from './europe.js';
import { EUROPE_ORTHOPHOTOS, europeOrthophotos } from './orthophotos.js';
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
});
