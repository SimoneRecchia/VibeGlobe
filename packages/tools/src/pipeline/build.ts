// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * A dataset build from a configuration file: license gate, estimate and confirmation before any download, then the
 * download, convert, tile and package steps of each dataset, each resumable (ADR 0024).
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type LoadedConfig, datasetArea, loadConfig } from '../config/load.js';
import type { DatasetConfig } from '../config/schema.js';
import { type BuildEstimate, estimateDataset, formatEstimate, totalEstimate } from '../estimate.js';
import { checkDatasets, describeViolations } from '../license/gate.js';
import { outputMetadata } from '../output/metadata.js';
import { outputPaths, writeOutputs } from '../output/write-outputs.js';
import { downloadAll } from '../sources/download.js';
import { type SourceFile, sourceFiles } from '../sources/files.js';
import type { AwsCredentials } from '../sources/sigv4.js';
import { coverage } from '../tiles/area.js';
import { writeBaseImage } from './base-image.js';
import { type DatasetFolders, convertSources, rasterMosaic, tileRasterDataset } from './raster-dataset.js';
import { StepLog, sha256 } from './step-log.js';
import { PIPELINE_VERSION } from '../version.js';
import { tileVectorDataset } from './vector-dataset.js';

/** The steps of a build, in order. */
export const STEPS = ['download', 'convert', 'tile', 'package'] as const;
/** One step of a build. */
export type Step = (typeof STEPS)[number];

/** Options of a build run. */
export interface BuildOptions {
  configPath: string;
  outDir: string;
  sample: boolean;
  /** Skip the confirmation prompt (explicit `--yes`). */
  yes: boolean;
  /** Whether a person can answer the prompt. */
  interactive: boolean;
  /** Run only up to this step (each step runs the ones before it, which resume). */
  until: Step;
  /** Restrict to these dataset ids. */
  datasets?: string[];
  /**
   * Replaces the source URL (base URL for bucket sources) of datasets by id: mirrors, a local copy, or the fixture
   * stub of a source that is unavailable. The license gate still checks the replacement.
   */
  sourceUrls?: Record<string, string>;
  fetch: typeof fetch;
  credentials?: AwsCredentials;
  ask: (question: string) => Promise<boolean>;
  report: (line: string) => void;
}

/** What a build did. */
export interface BuildResult {
  estimate: BuildEstimate;
  confirmed: boolean;
  transferredBytes: number;
  tilesBuilt: number;
  tilesSkipped: number;
  outputs: string[];
}

/** The datasets a run builds, with the sample area's minimum zoom applied. */
export function selectedDatasets(
  loaded: LoadedConfig,
  options: Pick<BuildOptions, 'sample' | 'datasets' | 'sourceUrls'>,
): DatasetConfig[] {
  const sampleMin = options.sample ? loaded.config.sampleArea.minZoom : undefined;
  return loaded.config.datasets
    .filter((d) => !options.datasets || options.datasets.includes(d.id))
    .map((d) => (sampleMin === undefined ? d : { ...d, minZoom: Math.min(d.maxZoom, Math.max(d.minZoom, sampleMin)) }))
    .map((d) => {
      const url = options.sourceUrls?.[d.id];
      if (url === undefined) return d;
      return { ...d, source: 'baseUrl' in d.source ? { ...d.source, baseUrl: url } : { ...d.source, url } };
    });
}

/** Estimates every selected dataset of a configuration; downloads nothing. */
export function estimateBuild(
  loaded: LoadedConfig,
  options: Pick<BuildOptions, 'sample' | 'datasets' | 'sourceUrls'>,
): BuildEstimate {
  const region = options.sample ? 'sample area' : 'region';
  const estimates = selectedDatasets(loaded, options).map((dataset) =>
    estimateDataset(dataset, datasetArea(loaded, dataset, options.sample), region),
  );
  return totalEstimate(estimates, loaded.config.prices);
}

async function confirm(options: BuildOptions, estimate: BuildEstimate): Promise<boolean> {
  options.report(formatEstimate(estimate));
  if (options.yes) return true;
  if (!options.interactive)
    throw new Error(
      'Not confirmed: non-interactive runs must pass --yes after reviewing the estimate. Nothing was downloaded.',
    );
  return options.ask('Proceed with the download and build? [y/N] ');
}

/** What the logged work of a dataset depends on: its configuration, area, tools and the pipeline (DP-002). */
function fingerprint(loaded: LoadedConfig, dataset: DatasetConfig, sample: boolean): { work: string; source: string } {
  const hash = (value: unknown): string => sha256(new TextEncoder().encode(JSON.stringify(value)));
  const area = datasetArea(loaded, dataset, sample);
  return {
    work: hash({ dataset, area, tools: loaded.config.tools, pipeline: PIPELINE_VERSION }),
    source: hash({ source: dataset.source, sourceVersion: dataset.sourceVersion }),
  };
}

function folders(loaded: LoadedConfig, options: BuildOptions, dataset: DatasetConfig): DatasetFolders {
  const root = options.outDir;
  const report = (line: string): void => options.report(`[${dataset.id}] ${line}`);
  const log = new StepLog(join(root, 'steps', `${dataset.id}.log`), fingerprint(loaded, dataset, options.sample));
  const work = join(root, 'work', dataset.id);
  const tiles = join(root, 'output', dataset.id);
  if (log.changed) {
    // Tiles of the earlier configuration (another zoom range or area) must not stay in the outputs.
    report('configuration changed since the logged work: converting and tiling again');
    for (const folder of [work, tiles]) rmSync(folder, { recursive: true, force: true });
  }
  return { downloads: join(root, 'downloads', dataset.id), work, tiles, log, report };
}

function lockOf(loaded: LoadedConfig): Record<string, string> {
  const path = loaded.path.replace(/\.json$/, '.lock.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>) : {};
}

/** Runs the steps of one dataset; returns transferred bytes, tile counts and written outputs. */
async function buildDataset(
  loaded: LoadedConfig,
  dataset: DatasetConfig,
  options: BuildOptions,
): Promise<{ transferred: number; built: number; skipped: number; outputs: string[] }> {
  const area = datasetArea(loaded, dataset, options.sample);
  const files: SourceFile[] = sourceFiles(dataset, { kind: 'bbox', bbox: coverage(area, dataset.minZoom) });
  const f = folders(loaded, options, dataset);
  const lock = lockOf(loaded);
  const downloadContext = { folder: f.downloads, log: f.log, fetch: options.fetch, lock, report: f.report };
  const results = await downloadAll(files, {
    ...downloadContext,
    ...(options.credentials ? { credentials: options.credentials } : {}),
  });
  const transferred = results.reduce((sum, r) => sum + r.transferred, 0);
  const result = { transferred, built: 0, skipped: 0, outputs: [] as string[] };
  if (options.until === 'download') return result;
  const converted =
    dataset.kind === 'vector'
      ? files.map((file) => join(f.downloads, file.key))
      : convertSources(dataset, files, f, loaded.config.tools.gdal, options.outDir);
  if (options.until === 'convert') return result;
  const counts =
    dataset.kind === 'vector'
      ? tileVectorDataset(dataset, area, converted, f)
      : tileRasterDataset(dataset, area, rasterMosaic(dataset, files, converted), f);
  Object.assign(result, counts);
  if (options.until === 'tile') return result;
  const metadata = outputMetadata(loaded.config, dataset, area.bbox);
  const paths = outputPaths(join(options.outDir, 'output'), dataset);
  result.outputs = writeOutputs(dataset, area, paths, metadata, f.report);
  if (dataset.baseImage && dataset.kind === 'imagery') {
    result.outputs.push(
      writeBaseImage(dataset, rasterMosaic(dataset, files, converted), join(options.outDir, 'output'), f),
    );
  }
  return result;
}

/** Runs a build. Throws before touching the disk or the network when the license gate refuses a source. */
export async function runBuild(options: BuildOptions): Promise<BuildResult> {
  const loaded = loadConfig(options.configPath);
  const datasets = selectedDatasets(loaded, options);
  const violations = checkDatasets(datasets);
  if (violations.length > 0) throw new Error(describeViolations(violations));
  const estimate = estimateBuild(loaded, options);
  const confirmed = await confirm(options, estimate);
  const result: BuildResult = { estimate, confirmed, transferredBytes: 0, tilesBuilt: 0, tilesSkipped: 0, outputs: [] };
  if (!confirmed) {
    options.report('Cancelled: nothing was downloaded or written.');
    return result;
  }
  for (const dataset of datasets) {
    // An unconfirmed or refused run never reaches this loop, so nothing exists on disk before it.
    const done = await buildDataset(loaded, dataset, options);
    result.transferredBytes += done.transferred;
    result.tilesBuilt += done.built;
    result.tilesSkipped += done.skipped;
    result.outputs.push(...done.outputs);
  }
  return result;
}
