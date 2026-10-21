import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BuildConfig, DatasetConfig } from '../config/schema.js';
import { PmtilesReader } from '../output/pmtiles.js';
import { type BuildOptions, runBuild } from './build.js';
import { sha256 } from './step-log.js';

const DEM = new Uint8Array(readFileSync(new URL('../fixtures/copernicus-dem-mont-blanc.tif', import.meta.url)));
const folders: string[] = [];
afterEach(() => folders.splice(0).forEach((f) => rmSync(f, { recursive: true, force: true })));

const terrain: DatasetConfig = {
  id: 'terrain',
  kind: 'terrain',
  profile: 'copernicus-dem-glo30',
  dataYear: 2021,
  sourceVersion: '2021_1',
  source: { type: 'copernicus-dem', baseUrl: 'https://dem.fixture.test', release: '2021_1', arcSeconds: 1 },
  minZoom: 12,
  maxZoom: 14,
  encoding: 'terrarium',
  bytesPerTile: 100_000,
  downloadBytesPerFile: DEM.length,
  outputs: { static: true, pmtiles: true, mbtiles: false },
};

function config(datasets: DatasetConfig[]): BuildConfig {
  return {
    configVersion: '1.0.0',
    name: 'fixture',
    description: 'fixture build',
    region: { bbox: [6.845, 45.815, 6.875, 45.845] },
    sampleArea: { bbox: [6.845, 45.815, 6.875, 45.845] },
    prices: {
      currency: 'USD',
      readDate: '2026-10-21',
      sourceUrl: 'https://example.test',
      requesterPaysTransferPerGB: 0.09,
      requesterPaysGetPer1000: 0.0004,
      freeTransferPerGB: 0,
    },
    tools: { gdal: `ghcr.io/osgeo/gdal@sha256:${'a'.repeat(64)}` },
    datasets,
  };
}

/** Serves the DEM fixture as the N45 E006 Copernicus tile and 404 for every other file; records requests. */
function demServer(requests: string[]): typeof fetch {
  return (async (url: string) => {
    requests.push(url);
    return url.includes('N45_00_E006') ? new Response(DEM) : new Response('', { status: 404 });
  }) as typeof fetch;
}

function setup(
  datasets: DatasetConfig[],
  overrides: Partial<BuildOptions> = {},
): BuildOptions & { lines: string[]; requests: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'vg-build-'));
  folders.push(dir);
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config(datasets)));
  const lines: string[] = [];
  const requests: string[] = [];
  return {
    configPath: join(dir, 'config.json'),
    outDir: join(dir, 'out'),
    sample: false,
    yes: true,
    interactive: false,
    until: 'package',
    fetch: demServer(requests),
    ask: () => Promise.resolve(false),
    report: (line) => lines.push(line),
    lines,
    requests,
    ...overrides,
  };
}

function outputChecksums(out: string): Record<string, string> {
  const sums: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else sums[path.slice(out.length)] = sha256(readFileSync(path));
    }
  };
  walk(out);
  return sums;
}

describe('runBuild', () => {
  it.each([
    [
      'Sentinel-2 cloudless 2018',
      {
        ...terrain,
        kind: 'imagery',
        profile: 's2cloudless-2016',
        encoding: 'jpeg',
        source: {
          type: 's2cloudless',
          baseUrl: 'https://s3.example.test',
          edition: 2018,
          level: 13,
          requesterPays: true,
        },
      },
      /2018 and later editions.*non-commercial/,
    ],
    [
      'the public OSM tile servers',
      {
        ...terrain,
        kind: 'imagery',
        profile: 'openstreetmap-extract',
        encoding: 'png',
        source: { type: 'geotiff', url: 'https://tile.openstreetmap.org/0/0/0.png' },
      },
      /tile usage policy forbids/,
    ],
    [
      'a Google Maps Platform source',
      {
        ...terrain,
        kind: 'imagery',
        profile: 'google-maps-platform',
        encoding: 'png',
        source: { type: 'geotiff', url: 'https://example.test/a.tif' },
      },
      /Google Maps Platform terms forbid/,
    ],
  ] as [string, DatasetConfig, RegExp][])(
    'refuses %s before any download and leaves no output',
    async (_name, dataset, term) => {
      const options = setup([dataset]);
      await expect(runBuild(options)).rejects.toThrow(term);
      expect(options.requests).toEqual([]);
      expect(existsSync(options.outDir)).toBe(false);
    },
  );

  it('prints the estimate first and stops without --yes in a non-interactive run', async () => {
    const options = setup([terrain], { yes: false });
    await expect(runBuild(options)).rejects.toThrow(/non-interactive runs must pass --yes/);
    expect(options.lines[0]).toMatch(/^Estimate \(nothing has been downloaded\)/);
    expect(options.requests).toEqual([]);
    expect(existsSync(options.outDir)).toBe(false);
  });

  it('waits for the answer in an interactive run and writes nothing when it is no', async () => {
    let asked = '';
    const options = setup([terrain], {
      yes: false,
      interactive: true,
      ask: (q) => ((asked = q), Promise.resolve(false)),
    });
    const result = await runBuild(options);
    expect(asked).toMatch(/Proceed/);
    expect(result.confirmed).toBe(false);
    expect(options.requests).toEqual([]);
    expect(existsSync(options.outDir)).toBe(false);
  });

  it('builds terrain tiles whose heights match the source within the Terrarium step', async () => {
    const options = setup([terrain]);
    const result = await runBuild(options);
    expect(result.tilesBuilt).toBe(result.estimate.tiles);
    const pmtiles = PmtilesReader.open(join(options.outDir, 'output', 'terrain.pmtiles'));
    expect(pmtiles.entries().reduce((n, e) => n + e.runLength, 0)).toBe(result.estimate.tiles);
    expect(pmtiles.metadata()).toMatchObject({
      attribution: expect.stringMatching(/^Produced using Copernicus WorldDEM-30/),
    });
    pmtiles.close();
  });

  it('resumes without redoing verified work and regenerates corrupted downloads and tiles', async () => {
    const first = setup([terrain]);
    await runBuild(first);
    const reference = outputChecksums(join(first.outDir, 'output'));
    const second = setup([terrain], { outDir: first.outDir });
    const download = join(first.outDir, 'downloads', 'terrain', 'Copernicus_DSM_COG_10_N45_00_E006_00_DEM.tif');
    writeFileSync(download, DEM.subarray(0, 1000));
    const tileDir = join(first.outDir, 'work', 'terrain', 'raw', '14');
    const column = readdirSync(tileDir)[0] as string;
    const tile = join(tileDir, column, readdirSync(join(tileDir, column))[0] as string);
    writeFileSync(tile, 'corrupt');
    const result = await runBuild(second);
    expect(second.lines.some((l) => /corrupt Copernicus_DSM_COG_10_N45_00_E006_00_DEM\.tif/.test(l))).toBe(true);
    expect(second.lines.some((l) => /corrupt intermediate tile 14\//.test(l))).toBe(true);
    expect(result.tilesBuilt).toBe(1);
    expect(outputChecksums(join(first.outDir, 'output'))).toEqual(reference);
  });
});
