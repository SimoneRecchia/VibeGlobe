import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_DIR } from '../cli.js';
import { estimateBuild } from '../pipeline/build.js';
import { configProblems, loadConfig } from './load.js';

const shipped = readdirSync(CONFIG_DIR).filter((f) => f.endsWith('.json') && !f.endsWith('.lock.json'));

describe('configuration files', () => {
  it.each(shipped)('%s is valid and pins its sources and tool images', (file) => {
    const { config } = loadConfig(join(CONFIG_DIR, file));
    expect(config.tools.gdal).toMatch(/@sha256:[0-9a-f]{64}$/);
    for (const dataset of config.datasets) expect(dataset.sourceVersion).not.toBe('');
  });

  it('reports every problem of an invalid configuration', () => {
    const { config } = loadConfig(join(CONFIG_DIR, 'italy-high.json'));
    const broken = {
      ...config,
      tools: { gdal: 'ghcr.io/osgeo/gdal:latest' },
      datasets: [{ ...config.datasets[0], minZoom: 15, maxZoom: 3, profile: 'nope', encoding: 'jpeg' }],
    };
    const problems = configProblems(broken).join('\n');
    expect(problems).toMatch(/tools.gdal: must be a Docker image pinned by digest/);
    expect(problems).toMatch(/minZoom and maxZoom/);
    expect(problems).toMatch(/unknown provider profile "nope"/);
    expect(problems).toMatch(/terrain needs one of terrarium/);
  });

  it('the world and Italy configurations cover every default dataset and estimate without downloading', () => {
    const world = loadConfig(join(CONFIG_DIR, 'world-low.json'));
    const italy = loadConfig(join(CONFIG_DIR, 'italy-high.json'));
    const profiles = (c: typeof world): string[] => c.config.datasets.map((d) => d.profile).sort();
    expect(profiles(world)).toEqual([
      'copernicus-dem-glo30',
      'natural-earth',
      'openstreetmap-extract',
      's2cloudless-2016',
    ]);
    expect(profiles(italy)).toEqual(['copernicus-dem-glo30', 'openstreetmap-extract', 's2cloudless-2016']);
    const estimate = estimateBuild(italy, { sample: false });
    const imagery = estimate.datasets.find((d) => d.dataset === 'imagery');
    expect(imagery?.zooms.map((z) => z.z)).toEqual([9, 10, 11, 12, 13, 14]);
    expect(estimate.cost).toBeGreaterThan(0);
    expect(estimate.downloadBytes).toBeGreaterThan(1e9);
  });
});
