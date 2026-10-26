// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Real tile sizes for the estimate (`estimate --measure`, F615), measured on a sample instead of the whole region:
 * archive sources read a few tiles per zoom with range requests; built sources run the pipeline on the configuration's
 * land sample area and, when given, its sea sample area, and average what they wrote.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type LoadedConfig, datasetArea } from './config/load.js';
import type { DatasetConfig, SampleAreaConfig } from './config/schema.js';
import type { MeasuredSizes } from './estimate.js';
import { runBuild, selectedDatasets } from './pipeline/build.js';
import { openArchive } from './pipeline/pmtiles-extract.js';
import { areaTiles } from './tiles/area.js';

/** Tiles read per zoom from an archive. */
const SAMPLE_TILES = 8;

/** Measured sizes per dataset id, and why some could not be measured. */
export interface Measurement {
  sizes: Record<string, MeasuredSizes>;
  notes: string[];
}

/** Average size per zoom of the tiles a build wrote into `folder` (`z/x/y.ext`). */
function averageSizes(folder: string): Record<number, number> {
  const out: Record<number, number> = {};
  let zooms: string[];
  try {
    zooms = readdirSync(folder).filter((name) => /^\d+$/.test(name));
  } catch {
    return out;
  }
  for (const z of zooms) {
    let bytes = 0;
    let count = 0;
    for (const x of readdirSync(join(folder, z)))
      for (const y of readdirSync(join(folder, z, x))) {
        bytes += statSync(join(folder, z, x, y)).size;
        count++;
      }
    if (count > 0) out[Number(z)] = Math.round(bytes / count);
  }
  return out;
}

/** The configuration with its sample area replaced (the sea sample). */
function withSample(loaded: LoadedConfig, sampleArea: SampleAreaConfig): LoadedConfig {
  return { ...loaded, config: { ...loaded.config, sampleArea } };
}

/** Builds a dataset over the sample area into a scratch folder and averages its tiles' sizes per zoom. */
async function builtSizes(
  loaded: LoadedConfig,
  dataset: DatasetConfig,
  fetchImpl: typeof fetch,
): Promise<Record<number, number>> {
  const outDir = mkdtempSync(join(tmpdir(), 'vibeglobe-measure-'));
  try {
    await runBuild({
      configPath: loaded.path,
      loaded,
      outDir,
      sample: true,
      yes: true,
      interactive: false,
      until: 'tile',
      datasets: [dataset.id],
      fetch: fetchImpl,
      ask: () => Promise.resolve(true),
      report: () => undefined,
    });
    return averageSizes(join(outDir, 'output', dataset.id));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/** Reads a few tiles per zoom of the sample area from the dataset's archive and averages their sizes. */
async function archiveSizes(
  loaded: LoadedConfig,
  dataset: DatasetConfig,
  fetchImpl: typeof fetch,
): Promise<Record<number, number>> {
  if (dataset.source.type !== 'pmtiles') return {};
  const archive = openArchive(dataset.source, fetchImpl);
  const area = datasetArea(loaded, dataset, true);
  const out: Record<number, number> = {};
  for (let z = Math.max(dataset.minZoom, loaded.config.sampleArea.minZoom ?? 0); z <= dataset.maxZoom; z++) {
    const tiles = [...areaTiles(area, z)];
    const step = Math.max(1, Math.floor(tiles.length / SAMPLE_TILES));
    let bytes = 0;
    let count = 0;
    for (let i = 0; i < tiles.length && count < SAMPLE_TILES; i += step) {
      const tile = tiles[i];
      const found = tile ? await archive.getZxy(tile.z, tile.x, tile.y) : undefined;
      if (found) {
        bytes += found.data.byteLength;
        count++;
      }
    }
    if (count > 0) out[z] = Math.round(bytes / count);
  }
  return out;
}

/** Measures the tile sizes of the selected datasets on the configuration's sample areas. */
export async function measureSizes(
  loaded: LoadedConfig,
  options: { datasets?: string[]; fetch: typeof fetch },
): Promise<Measurement> {
  const measurement: Measurement = { sizes: {}, notes: [] };
  for (const dataset of selectedDatasets(loaded, {
    sample: true,
    ...(options.datasets ? { datasets: options.datasets } : {}),
  })) {
    const measure = (config: LoadedConfig) =>
      dataset.source.type === 'pmtiles'
        ? archiveSizes(config, dataset, options.fetch)
        : builtSizes(config, dataset, options.fetch);
    try {
      const land = await measure(loaded);
      const seaArea = loaded.config.seaSampleArea;
      const sea = seaArea && dataset.seaMaxZoom !== undefined ? await measure(withSample(loaded, seaArea)) : {};
      const sizes: MeasuredSizes = {};
      for (const z of new Set([...Object.keys(land), ...Object.keys(sea)].map(Number)))
        sizes[z] = {
          ...(land[z] !== undefined ? { land: land[z] } : {}),
          ...(sea[z] !== undefined ? { sea: sea[z] } : {}),
        };
      measurement.sizes[dataset.id] = sizes;
      if (Object.keys(sizes).length === 0)
        measurement.notes.push(`${dataset.id}: the sample has no tiles; sizes configured`);
    } catch (error) {
      measurement.notes.push(
        `${dataset.id}: not measured (${error instanceof Error ? error.message : String(error)}); sizes configured`,
      );
    }
  }
  return measurement;
}
