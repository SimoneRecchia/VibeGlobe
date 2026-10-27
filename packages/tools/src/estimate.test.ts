import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_DIR } from './cli.js';
import { loadConfig } from './config/load.js';
import { formatEstimate } from './estimate.js';
import { estimateBuild } from './pipeline/build.js';

const europe = loadConfig(join(CONFIG_DIR, 'europe.json'));

describe('the Europe package and its estimate (F614, F615)', () => {
  it('builds the preset’s packaged sources, counting land and sea apart and only land beyond the sea’s last zoom', () => {
    const datasets = europe.config.datasets;
    expect(datasets.map((d) => [d.id, d.kind, d.profile])).toEqual([
      ['europe-satellite', 'imagery', 'esa-worldcover-s2-2021'],
      ['europe-terrain', 'terrain', 'mapterhorn'],
      ['europe-vectors', 'vector', 'openfreemap-planet'],
    ]);
    const estimate = estimateBuild(europe, { sample: false, datasets: ['europe-satellite'] });
    const zooms = estimate.datasets[0]?.zooms ?? [];
    for (const zoom of zooms) {
      expect((zoom.land ?? 0) + (zoom.sea ?? 0)).toBe(zoom.tiles);
      if (zoom.z > 8) expect(zoom.sea).toBe(0);
      else expect(zoom.sea).toBeGreaterThan(0);
    }
    // Land roughly quadruples per zoom.
    const z10 = zooms.find((z) => z.z === 10)?.land ?? 0;
    const z11 = zooms.find((z) => z.z === 11)?.land ?? 0;
    expect(z11 / z10).toBeGreaterThan(3.8);
    expect(z11 / z10).toBeLessThan(4.2);
  });

  it('prints per zoom the land and sea tiles and cumulative gigabytes, measured sizes replacing configured ones', () => {
    const measured = { 'europe-satellite': { 10: { land: 30_000 }, 11: { land: 28_000 } } };
    const estimate = estimateBuild(europe, { sample: false, datasets: ['europe-satellite'], measured });
    const zooms = estimate.datasets[0]?.zooms ?? [];
    const z11 = zooms.find((z) => z.z === 11);
    expect(z11?.measured).toBe(true);
    expect(z11?.bytes).toBe((z11?.land ?? 0) * 28_000);
    const text = formatEstimate(estimate);
    expect(text).toMatch(/zoom\s+land tiles\s+sea tiles\s+tiles\s+size\s+cumulative\s+sizes/);
    expect(text).toMatch(/z11\s+[\d,]+\s+0\s+[\d,]+\s+[\d.]+ GB\s+[\d.]+ GB\s+measured/);
    expect(text).toMatch(/z8\s+[\d,]+\s+[\d,]+\s+[\d,]+\s+[\d.]+ [kMG]B\s+[\d.]+ GB\s+configured/);
  });
});
