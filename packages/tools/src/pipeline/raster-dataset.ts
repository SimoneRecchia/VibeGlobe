/** Convert and tile steps of raster datasets (terrain and imagery). */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { runTool } from '../runner/docker.js';
import type { DatasetConfig } from '../config/schema.js';
import { encodeJpeg } from '../encode/jpeg.js';
import { encodePng } from '../encode/png.js';
import { encodeTerrariumTile } from '../encode/terrarium.js';
import { tileExtension } from '../output/metadata.js';
import { Mosaic, type MosaicEntry } from '../raster/mosaic.js';
import { readGeoTiff } from '../raster/tiff.js';
import { extractZipMember } from '../raster/zip.js';
import type { SourceFile } from '../sources/files.js';
import type { Area } from '../tiles/area.js';
import { TILE_PX, type TileEncoder, buildRasterTiles } from './raster-tiles.js';
import type { StepLog } from './step-log.js';

/** Folders and services of one dataset build. */
export interface DatasetFolders {
  downloads: string;
  work: string;
  tiles: string;
  log: StepLog;
  report: (line: string) => void;
}

/** The tile encoder of a raster dataset. */
function rasterEncoder(dataset: DatasetConfig): TileEncoder {
  if (dataset.encoding === 'terrarium') return (samples) => encodeTerrariumTile(samples, TILE_PX);
  const quality = dataset.quality ?? 85;
  return (samples) => {
    const rgb = new Uint8Array(samples.length);
    for (let i = 0; i < samples.length; i++) rgb[i] = Math.max(0, Math.min(255, Math.round(samples[i] ?? 0)));
    return dataset.encoding === 'jpeg'
      ? encodeJpeg(rgb, TILE_PX, TILE_PX, quality)
      : encodePng(rgb, TILE_PX, TILE_PX, 3);
  };
}

/**
 * The convert step: makes each downloaded file readable by the built-in reader. Zip archives are unpacked (logged and
 * checksummed like every step); GeoTIFFs are read in place.
 */
export function convertSources(
  dataset: DatasetConfig,
  files: SourceFile[],
  folders: DatasetFolders,
  gdalImage: string,
  root: string,
): string[] {
  const source = dataset.source;
  return files.map((file) => {
    const downloaded = join(folders.downloads, file.key);
    if (dataset.convert && existsSync(downloaded))
      return convertWithGdal(dataset.convert, file, downloaded, folders, gdalImage, root);
    if (source.type !== 'geotiff' || !source.member) return downloaded;
    const target = join(folders.work, 'source', source.member);
    const state = folders.log.check('convert', source.member, target);
    if (state === 'done') {
      folders.report(`skip convert ${source.member} (checksum verified)`);
      return target;
    }
    folders.log.write('convert', source.member, target, extractZipMember(readFileSync(downloaded), source.member));
    folders.report(`converted ${file.key} → ${source.member}`);
    return target;
  });
}

/** Runs the dataset's GDAL command on one file in the pinned image (skipped when its output is verified). */
function convertWithGdal(
  command: string[],
  file: SourceFile,
  input: string,
  folders: DatasetFolders,
  image: string,
  root: string,
): string {
  const output = join(folders.work, 'converted', `${file.key}.tif`);
  if (folders.log.check('convert', file.key, output) === 'done') return output;
  mkdirSync(dirname(output), { recursive: true });
  const temporary = `${output}.partial.tif`;
  const args = command.map((arg) =>
    arg.replace('{input}', relative(root, input)).replace('{output}', relative(root, temporary)),
  );
  runTool({ image, folder: root, command: args });
  folders.log.write('convert', file.key, output, new Uint8Array(readFileSync(temporary)));
  rmSync(temporary, { force: true });
  folders.report(`converted ${file.key} with ${command[0] ?? 'gdal'} in ${image}`);
  return output;
}

/** Builds the mosaic of converted files; files the download step found missing contribute no data. */
export function rasterMosaic(dataset: DatasetConfig, files: SourceFile[], paths: string[]): Mosaic {
  const world = { west: -180, south: -90, east: 180, north: 90 };
  const entries: MosaicEntry[] = files.map((file, i) => ({
    bounds: file.bounds ?? world,
    load: () => {
      const path = paths[i] as string;
      return existsSync(path) ? readGeoTiff(new Uint8Array(readFileSync(path))) : undefined;
    },
  }));
  const channels = dataset.kind === 'terrain' ? 1 : 3;
  return new Mosaic(entries, channels, new Array<number>(channels).fill(0));
}

/** The tile step of a raster dataset. */
export function tileRasterDataset(
  dataset: DatasetConfig,
  area: Area,
  mosaic: Mosaic,
  folders: DatasetFolders,
): { built: number; skipped: number } {
  return buildRasterTiles({
    area,
    minZoom: dataset.minZoom,
    maxZoom: dataset.maxZoom,
    mosaic,
    rawFolder: join(folders.work, 'raw'),
    tileFolder: folders.tiles,
    extension: tileExtension(dataset),
    encode: rasterEncoder(dataset),
    log: folders.log,
    report: folders.report,
  });
}
