// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** Loading and validating build configuration files. */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { findProfile } from '../license/profiles.js';
import { type Area, type Ring, clipArea, polygonArea } from '../tiles/area.js';
import { bboxProblems } from '../tiles/mercator.js';
import type { AreaConfig, BuildConfig, DatasetConfig } from './schema.js';

/** A Docker image reference pinned by digest. */
export const PINNED_IMAGE = /^[a-z0-9./_-]+(:[\w.-]+)?@sha256:[0-9a-f]{64}$/;

const ENCODINGS: Record<DatasetConfig['kind'], DatasetConfig['encoding'][]> = {
  terrain: ['terrarium'],
  imagery: ['png', 'jpeg'],
  vector: ['mvt'],
};
const SOURCES: Record<DatasetConfig['kind'], string[]> = {
  terrain: ['copernicus-dem'],
  imagery: ['worldcover-s2', 's2cloudless', 'geotiff', 'xyz'],
  vector: ['osm-extract'],
};
const MAX_ZOOM = 22;

/** A loaded configuration with the file it came from. */
export interface LoadedConfig {
  config: BuildConfig;
  path: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function areaProblems(where: string, area: unknown): string[] {
  if (!isRecord(area)) return [`${where}: must be an object with "bbox" or "polygon"`];
  if (Array.isArray(area['bbox'])) {
    const [west, south, east, north] = area['bbox'] as number[];
    if (area['bbox'].length !== 4) return [`${where}.bbox: must be [west, south, east, north]`];
    return bboxProblems({
      west: west ?? NaN,
      south: south ?? NaN,
      east: east ?? NaN,
      north: north ?? NaN,
    }).map((p) => `${where}.bbox: ${p}`);
  }
  if (typeof area['polygon'] === 'string' || Array.isArray(area['polygon'])) return [];
  return [`${where}: must have "bbox" or "polygon"`];
}

function datasetProblems(dataset: DatasetConfig, index: number): string[] {
  const where = `datasets[${index}]${typeof dataset.id === 'string' ? ` (${dataset.id})` : ''}`;
  const problems: string[] = [];
  if (typeof dataset.id !== 'string' || !/^[a-z0-9-]+$/.test(dataset.id))
    problems.push(`${where}.id: must be lowercase letters, digits and dashes`);
  if (!(dataset.kind in ENCODINGS)) return [...problems, `${where}.kind: must be terrain, imagery or vector`];
  if (!findProfile(dataset.profile)) problems.push(`${where}.profile: unknown provider profile "${dataset.profile}"`);
  if (!ENCODINGS[dataset.kind].includes(dataset.encoding))
    problems.push(`${where}.encoding: ${dataset.kind} needs one of ${ENCODINGS[dataset.kind].join(', ')}`);
  if (!isRecord(dataset.source) || !SOURCES[dataset.kind].includes(String(dataset.source['type'])))
    problems.push(`${where}.source.type: ${dataset.kind} needs one of ${SOURCES[dataset.kind].join(', ')}`);
  const zooms = [dataset.minZoom, dataset.maxZoom];
  if (!zooms.every((z) => Number.isInteger(z) && z >= 0 && z <= MAX_ZOOM) || dataset.minZoom > dataset.maxZoom)
    problems.push(`${where}: minZoom and maxZoom must be integers with 0 ≤ minZoom ≤ maxZoom ≤ ${MAX_ZOOM}`);
  if (!Number.isInteger(dataset.dataYear)) problems.push(`${where}.dataYear: must be an integer year`);
  if (typeof dataset.sourceVersion !== 'string' || dataset.sourceVersion === '')
    problems.push(`${where}.sourceVersion: must pin the source version`);
  const outputs = dataset.outputs as unknown;
  if (!isRecord(outputs) || !(outputs['static'] || outputs['pmtiles'] || outputs['mbtiles']))
    problems.push(`${where}.outputs: enable at least one of static, pmtiles, mbtiles`);
  const bytes = dataset.bytesPerTile as unknown;
  if (!(typeof bytes === 'number' && bytes > 0) && !isRecord(bytes))
    problems.push(`${where}.bytesPerTile: must be a positive number or a map from zoom to bytes`);
  if (!(typeof dataset.downloadBytesPerFile === 'number' && dataset.downloadBytesPerFile > 0))
    problems.push(`${where}.downloadBytesPerFile: must be a positive number`);
  if (dataset.area !== undefined) problems.push(...areaProblems(`${where}.area`, dataset.area));
  const stretch = dataset.colorStretch as unknown;
  if (
    stretch !== undefined &&
    !(
      isRecord(stretch) &&
      Number.isInteger(stretch['maxReflectance']) &&
      Number(stretch['maxReflectance']) > 0 &&
      Number(stretch['gamma']) > 0 &&
      Array.isArray(stretch['noDataReflectance']) &&
      stretch['noDataReflectance'].length === 3
    )
  )
    problems.push(
      `${where}.colorStretch: needs an integer maxReflectance > 0, gamma > 0 and three noDataReflectance values`,
    );
  return problems;
}

/** Every problem of a parsed configuration; empty when valid. */
export function configProblems(value: unknown): string[] {
  if (!isRecord(value)) return ['configuration must be a JSON object'];
  const config = value as unknown as BuildConfig;
  const problems: string[] = [];
  if (typeof config.configVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(config.configVersion))
    problems.push('configVersion: must be a semantic version');
  if (typeof config.name !== 'string' || !/^[a-z0-9-]+$/.test(config.name))
    problems.push('name: must be lowercase letters, digits and dashes');
  problems.push(...areaProblems('region', config.region), ...areaProblems('sampleArea', config.sampleArea));
  const prices = config.prices as unknown;
  if (!isRecord(prices) || !/^\d{4}-\d{2}-\d{2}$/.test(String(prices['readDate'])))
    problems.push('prices: must record per-GB prices with their readDate (YYYY-MM-DD) and sourceUrl');
  const tools = config.tools as unknown;
  if (!isRecord(tools) || !PINNED_IMAGE.test(String(tools['gdal'])))
    problems.push('tools.gdal: must be a Docker image pinned by digest (name@sha256:…)');
  if (!Array.isArray(config.datasets) || config.datasets.length === 0) problems.push('datasets: must not be empty');
  else {
    config.datasets.forEach((dataset, i) => problems.push(...datasetProblems(dataset, i)));
    const ids = config.datasets.map((d) => d.id);
    if (new Set(ids).size !== ids.length) problems.push('datasets: ids must be unique');
  }
  return problems;
}

/** Reads and validates a configuration file; throws with every problem listed. */
export function loadConfig(path: string): LoadedConfig {
  const absolute = resolve(path);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(`${path}: cannot read configuration: ${(error as Error).message}`, { cause: error });
  }
  const problems = configProblems(value);
  if (problems.length > 0) throw new Error(`${path}: invalid configuration:\n  ${problems.join('\n  ')}`);
  return { config: value as BuildConfig, path: absolute };
}

function readPolygonFile(path: string): Ring[] {
  const json = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const geometry = (json['type'] === 'Feature' ? json['geometry'] : json) as { type?: string; coordinates?: unknown };
  if (geometry.type === 'Polygon') return geometry.coordinates as Ring[];
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates as Ring[][]).flat();
  throw new Error(`${path}: expected a GeoJSON Polygon or MultiPolygon`);
}

/** Resolves an area of a configuration; polygon paths are relative to the configuration file. */
function resolveArea(area: AreaConfig, configPath: string): Area {
  if (area.bbox) {
    const [west, south, east, north] = area.bbox;
    return { kind: 'bbox', bbox: { west, south, east, north } };
  }
  const rings =
    typeof area.polygon === 'string'
      ? readPolygonFile(resolve(dirname(configPath), area.polygon))
      : (area.polygon ?? []);
  return polygonArea(rings);
}

/** The area a dataset builds: its own area or the build's region, clipped to the sample area when `sample` is set. */
export function datasetArea(loaded: LoadedConfig, dataset: DatasetConfig, sample: boolean): Area {
  const area = resolveArea(dataset.area ?? loaded.config.region, loaded.path);
  return sample ? clipArea(area, resolveArea(loaded.config.sampleArea, loaded.path).bbox) : area;
}
