// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Machine-readable license and attribution metadata of every output (F337): the static folder's `metadata.json`, the
 * PMTiles JSON metadata and the MBTiles metadata table all carry the same fields.
 */
import type { BuildConfig, DatasetConfig } from '../config/schema.js';
import { attributionFor, findProfile } from '../license/profiles.js';
import type { BBoxDeg } from '../tiles/mercator.js';
import { VECTOR_LAYERS } from '../vector/features.js';
import { PIPELINE_VERSION } from '../version.js';

/** The metadata of one dataset output. */
export interface OutputMetadata {
  name: string;
  description: string;
  format: string;
  type: 'baselayer' | 'overlay';
  minzoom: number;
  maxzoom: number;
  bounds: [number, number, number, number];
  /** The credit to display, exactly as the license requires. */
  attribution: string;
  license: string;
  licenseUrl: string;
  sources: { name: string; url: string; license: string; version: string; dataYear: number; termsReadDate: string }[];
  dataYear: number;
  configName: string;
  configVersion: string;
  pipelineVersion: string;
  encoding: DatasetConfig['encoding'];
  /** Vector layers (MVT outputs only), as TileJSON lists them. */
  vector_layers?: { id: string; fields: Record<string, string> }[];
}

const FORMATS: Record<DatasetConfig['encoding'], string> = { terrarium: 'png', png: 'png', jpeg: 'jpg', mvt: 'pbf' };

/** File extension of a dataset's tiles. */
export function tileExtension(dataset: DatasetConfig): string {
  // Tiles copied from an archive keep its format (Mapterhorn's Terrarium terrain is WebP).
  return dataset.source.type === 'pmtiles' ? dataset.source.extension : FORMATS[dataset.encoding];
}

/** Builds the metadata of one dataset output. */
export function outputMetadata(config: BuildConfig, dataset: DatasetConfig, bounds: BBoxDeg): OutputMetadata {
  const profile = findProfile(dataset.profile);
  if (!profile) throw new Error(`${dataset.id}: unknown provider profile ${dataset.profile}`);
  const attribution = attributionFor(profile, dataset.dataYear);
  return {
    name: `${config.name}-${dataset.id}`,
    description: `${profile.name}, ${config.description}`,
    format: tileExtension(dataset),
    type: dataset.kind === 'imagery' ? 'baselayer' : 'overlay',
    minzoom: dataset.minZoom,
    maxzoom: dataset.maxZoom,
    bounds: [bounds.west, bounds.south, bounds.east, bounds.north],
    attribution,
    license: profile.license,
    licenseUrl: profile.licenseUrl,
    sources: [
      {
        name: profile.name,
        url: profile.sourceUrl,
        license: profile.license,
        version: dataset.sourceVersion,
        dataYear: dataset.dataYear,
        termsReadDate: profile.termsReadDate,
      },
    ],
    dataYear: dataset.dataYear,
    configName: config.name,
    configVersion: config.configVersion,
    pipelineVersion: PIPELINE_VERSION,
    encoding: dataset.encoding,
    ...(dataset.kind === 'vector' ? { vector_layers: VECTOR_LAYERS } : {}),
  };
}

/** The metadata as MBTiles string rows (objects and arrays as JSON). */
export function mbtilesMetadata(metadata: OutputMetadata): Record<string, string> {
  const rows: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key === 'vector_layers') continue;
    rows[key] =
      typeof value === 'string' ? value : key === 'bounds' ? (value as number[]).join(',') : JSON.stringify(value);
  }
  if (metadata.vector_layers) rows['json'] = JSON.stringify({ vector_layers: metadata.vector_layers });
  return rows;
}
