// F341's last step, across the two tracks' packages: the vector tiles the data pipeline builds from an OpenStreetMap
// extract pass the engine's MVT adapter conformance suite, with roads, places and buildings (heights and levels).
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeMvt, type MvtTile } from '@vibeglobe/sources/vector';
import { failures, runParserConformance } from '@vibeglobe/sources/conformance';
import { runBuild } from '@vibeglobe/tools';
import { afterAll, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'vg-osm-mvt-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The pipeline's synthetic OpenStreetMap extract around Mont Blanc (the real extract needs Geofabrik). */
async function syntheticExtract(): Promise<Uint8Array> {
  const module = (await import(new URL('../../packages/tools/src/fixtures/osm-sample.ts', import.meta.url).href)) as {
    syntheticOsmExtract(): Uint8Array;
  };
  return module.syntheticOsmExtract();
}

function tiles(root: string): { name: string; bytes: Uint8Array }[] {
  const out: { name: string; bytes: Uint8Array }[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.pbf'))
        out.push({ name: full.slice(root.length + 1), bytes: new Uint8Array(readFileSync(full)) });
    }
  };
  walk(root);
  return out;
}

it(
  'the OpenStreetMap vector tiles of the data pipeline pass the MVT conformance suite (F341)',
  { timeout: 60_000 },
  async () => {
    const extract = await syntheticExtract();
    const config = {
      configVersion: '1.0.0',
      name: 'osm-sample',
      description: 'OpenStreetMap vector tiles of the pipeline sample',
      region: { bbox: [6.6796875, 45.82879925192134, 7.03125, 46.07323062540836] },
      sampleArea: { bbox: [6.6796875, 45.82879925192134, 7.03125, 46.07323062540836] },
      prices: {
        currency: 'USD',
        readDate: '2026-10-21',
        sourceUrl: 'https://example.test',
        requesterPaysTransferPerGB: 0.09,
        requesterPaysGetPer1000: 0.0004,
        freeTransferPerGB: 0,
      },
      tools: { gdal: `ghcr.io/osgeo/gdal@sha256:${'a'.repeat(64)}` },
      datasets: [
        {
          id: 'vectors',
          kind: 'vector',
          profile: 'openstreetmap-extract',
          dataYear: 2026,
          sourceVersion: '261020',
          source: { type: 'osm-extract', url: 'https://download.fixture.test/europe/italy-261020.osm.pbf' },
          minZoom: 10,
          maxZoom: 14,
          encoding: 'mvt',
          bytesPerTile: 100_000,
          downloadBytesPerFile: extract.length,
          outputs: { static: true, pmtiles: false, mbtiles: false },
        },
      ],
    };
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
    await runBuild({
      configPath: join(dir, 'config.json'),
      outDir: join(dir, 'out'),
      sample: false,
      yes: true,
      interactive: false,
      until: 'package',
      fetch: (() => Promise.resolve(new Response(extract.slice()))) as typeof fetch,
      ask: () => Promise.resolve(false),
      report: () => undefined,
    });
    const built = tiles(join(dir, 'out', 'output', 'vectors'));
    expect(built.length).toBeGreaterThan(10);
    const layersSeen = new Set<string>();
    let buildingWithHeight = false;
    const results = await runParserConformance({
      name: 'pipeline OpenStreetMap tiles',
      parse: (input: Uint8Array) => decodeMvt(input),
      fixtures: built.map((tile) => ({
        name: tile.name,
        input: tile.bytes,
        expect: (decoded: MvtTile | undefined) => {
          if (!decoded || decoded.issues.length > 0) return `not a valid tile: ${JSON.stringify(decoded?.issues)}`;
          for (const layer of decoded.layers) {
            layersSeen.add(layer.name);
            if (layer.name === 'buildings')
              buildingWithHeight ||= layer.features.some(
                (f) => f.properties['height'] !== undefined && f.properties['levels'] !== undefined,
              );
          }
          return undefined;
        },
      })),
      fuzzRuns: 5,
    });
    expect(failures(results)).toEqual([]);
    expect([...layersSeen].sort()).toEqual(['buildings', 'places', 'roads']);
    expect(buildingWithHeight).toBe(true);
  },
);

it(
  'the OpenStreetMap vector outputs of both shipped configurations, built on their sample areas, pass the MVT conformance suite (F551)',
  { timeout: 120_000 },
  async () => {
    const extract = await syntheticExtract();
    for (const config of ['world-low', 'italy-high']) {
      const out = join(dir, `${config}-sample`);
      await runBuild({
        configPath: new URL(`../../packages/tools/configs/${config}.json`, import.meta.url).pathname,
        outDir: out,
        sample: true,
        yes: true,
        interactive: false,
        until: 'package',
        datasets: ['vectors'],
        // The synthetic extract stands in for the planet file (95 GB) and the Geofabrik extract.
        sourceUrls: { vectors: 'https://download.fixture.test/sample.osm.pbf' },
        fetch: (() => Promise.resolve(new Response(extract.slice()))) as typeof fetch,
        ask: () => Promise.resolve(false),
        report: () => undefined,
      });
      const built = tiles(join(out, 'output', 'vectors'));
      expect(built.length, config).toBeGreaterThan(0);
      const results = await runParserConformance({
        name: `${config} sample vector tiles`,
        parse: (input: Uint8Array) => decodeMvt(input),
        fixtures: built.map((tile) => ({
          name: tile.name,
          input: tile.bytes,
          expect: (decoded: MvtTile | undefined) =>
            decoded && decoded.issues.length === 0 && decoded.layers.length > 0
              ? undefined
              : `not a valid tile: ${JSON.stringify(decoded?.issues)}`,
        })),
        fuzzRuns: 5,
      });
      expect(failures(results), config).toEqual([]);
    }
  },
);
