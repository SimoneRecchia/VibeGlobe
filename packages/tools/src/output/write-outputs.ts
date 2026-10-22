/** The package step: static folder metadata, PMTiles and MBTiles from a dataset's encoded tiles (F336). */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatasetConfig } from '../config/schema.js';
import { writeAtomic } from '../pipeline/step-log.js';
import { type Area, areaTiles } from '../tiles/area.js';
import { writeMbtiles } from './mbtiles.js';
import { type OutputMetadata, mbtilesMetadata, tileExtension } from './metadata.js';
import { COMPRESSION, TILE_TYPES, writePmtiles } from './pmtiles.js';

/** Paths of a dataset's outputs. */
export interface OutputPaths {
  staticFolder: string;
  pmtiles?: string;
  mbtiles?: string;
}

/** The output paths of a dataset inside a build's output folder. */
export function outputPaths(outputFolder: string, dataset: DatasetConfig): OutputPaths {
  return {
    staticFolder: join(outputFolder, dataset.id),
    ...(dataset.outputs.pmtiles ? { pmtiles: join(outputFolder, `${dataset.id}.pmtiles`) } : {}),
    ...(dataset.outputs.mbtiles ? { mbtiles: join(outputFolder, `${dataset.id}.mbtiles`) } : {}),
  };
}

/** Every built tile of a dataset with a reader of its encoded bytes. */
function builtTiles(
  dataset: DatasetConfig,
  area: Area,
  staticFolder: string,
): { z: number; x: number; y: number; read: () => Uint8Array }[] {
  const tiles = [];
  for (let z = dataset.minZoom; z <= dataset.maxZoom; z++) {
    for (const tile of areaTiles(area, z)) {
      const path = join(staticFolder, `${z}/${tile.x}/${tile.y}.${tileExtension(dataset)}`);
      // Vector tiles without features are not written.
      if (dataset.kind !== 'vector' || existsSync(path))
        tiles.push({ ...tile, read: () => new Uint8Array(readFileSync(path)) });
    }
  }
  return tiles;
}

/** Writes the metadata file and the enabled packages; returns the written paths. */
export function writeOutputs(
  dataset: DatasetConfig,
  area: Area,
  paths: OutputPaths,
  metadata: OutputMetadata,
  report: (line: string) => void,
): string[] {
  const written = [join(paths.staticFolder, 'metadata.json')];
  writeAtomic(written[0] as string, `${JSON.stringify(metadata, null, 2)}\n`);
  const tiles = builtTiles(dataset, area, paths.staticFolder);
  if (paths.pmtiles) {
    const [west, south, east, north] = metadata.bounds;
    const { addressed, contents } = writePmtiles(
      paths.pmtiles,
      tiles,
      {
        tileType: TILE_TYPES[dataset.encoding === 'terrarium' ? 'png' : dataset.encoding],
        tileCompression: COMPRESSION.none,
        minZoom: dataset.minZoom,
        maxZoom: dataset.maxZoom,
        bounds: { west, south, east, north },
        center: { lon: (west + east) / 2, lat: (south + north) / 2, zoom: dataset.minZoom },
      },
      metadata,
    );
    report(`wrote ${paths.pmtiles} (${addressed} tiles, ${contents} unique)`);
    written.push(paths.pmtiles);
  }
  if (paths.mbtiles) {
    writeMbtiles(paths.mbtiles, tiles, mbtilesMetadata(metadata));
    report(`wrote ${paths.mbtiles} (${tiles.length} tiles)`);
    written.push(paths.mbtiles);
  }
  if (!dataset.outputs.static) report('static folder kept as the packages’ source (outputs.static is false)');
  return written;
}
