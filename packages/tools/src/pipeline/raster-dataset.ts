// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
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
import { type Raster, readGeoTiff } from '../raster/tiff.js';
import { extractZipMember } from '../raster/zip.js';
import type { SourceFile } from '../sources/files.js';
import type { Area } from '../tiles/area.js';
import type { TileCoord } from '../tiles/mercator.js';
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

/**
 * Maps a sample to a byte: clamped as is, or through the dataset's colour stretch (ADR 0026),
 * `255 × min(1, reflectance / maxReflectance) ^ (1 / gamma)`, tabulated for every integer reflectance.
 */
export function byteMapping(dataset: DatasetConfig): (sample: number) => number {
  const stretch = dataset.colorStretch;
  if (!stretch) return (sample) => Math.max(0, Math.min(255, Math.round(sample)));
  const table = new Uint8Array(stretch.maxReflectance + 1);
  for (let r = 0; r <= stretch.maxReflectance; r++)
    table[r] = Math.round(255 * (r / stretch.maxReflectance) ** (1 / stretch.gamma));
  return (sample) => table[Math.max(0, Math.min(stretch.maxReflectance, Math.round(sample)))] ?? 255;
}

/** The pixels of neighbor samples around each tile of a dataset: 1 for terrain (KB-178), else 0. */
function terrainBorderPx(dataset: DatasetConfig): number {
  return dataset.encoding === 'terrarium' ? 1 : 0;
}

/** The tile encoder of a raster dataset. */
function rasterEncoder(dataset: DatasetConfig): TileEncoder {
  if (dataset.encoding === 'terrarium') return (samples, sizePx) => encodeTerrariumTile(samples, sizePx);
  const quality = dataset.quality ?? 85;
  const toByte = byteMapping(dataset);
  return (samples) => {
    const rgb = new Uint8Array(samples.length);
    for (let i = 0; i < samples.length; i++) rgb[i] = toByte(samples[i] ?? 0);
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
  const read = (path: string | undefined): Raster | undefined =>
    path !== undefined && existsSync(path) ? readGeoTiff(new Uint8Array(readFileSync(path))) : undefined;
  const source = dataset.source;
  const gapFill = source.type === 'worldcover-s2' ? source.gapFill : undefined;
  const entries: MosaicEntry[] = [];
  files.forEach((file, i) => {
    if (file.gapMapFor !== undefined) return;
    const map = gapFill ? files.findIndex((f) => f.gapMapFor === file.key) : -1;
    entries.push({
      bounds: file.bounds ?? world,
      load: () => {
        const raster = read(paths[i]);
        const classes = map < 0 ? undefined : read(paths[map]);
        if (raster && classes && gapFill) fillGaps(raster, classes, gapFill.classReflectance);
        return raster;
      },
    });
  });
  const channels = dataset.kind === 'terrain' ? 1 : 3;
  const fill = dataset.colorStretch?.noDataReflectance ?? new Array<number>(channels).fill(0);
  return new Mosaic(entries, channels, fill);
}

/**
 * Gives every pixel without data in any band the reflectance of its land-cover class (ADR 0026), in place; pixels of
 * classes without a colour (water) stay without data.
 */
export function fillGaps(
  raster: Raster,
  classes: Raster,
  classReflectance: Record<string, [number, number, number]>,
): void {
  const spp = raster.samplesPerPixel;
  const colours = new Map(Object.entries(classReflectance).map(([code, rgb]) => [Number(code), rgb]));
  for (let row = 0; row < raster.height; row++) {
    const lat = raster.northDeg - (row + 0.5) * raster.pixelHeightDeg;
    const mapRow = Math.floor((classes.northDeg - lat) / classes.pixelHeightDeg);
    if (mapRow < 0 || mapRow >= classes.height) continue;
    for (let col = 0; col < raster.width; col++) {
      const at = (row * raster.width + col) * spp;
      let empty = true;
      for (let c = 0; c < spp && empty; c++) empty = raster.data[at + c] === 0;
      if (!empty) continue;
      const lon = raster.westDeg + (col + 0.5) * raster.pixelWidthDeg;
      const mapCol = Math.floor((lon - classes.westDeg) / classes.pixelWidthDeg);
      if (mapCol < 0 || mapCol >= classes.width) continue;
      const rgb = colours.get(classes.data[mapRow * classes.width + mapCol] ?? 0);
      if (rgb) for (let c = 0; c < 3; c++) raster.data[at + c] = rgb[c] ?? 0;
    }
  }
}

/** The tile step of a raster dataset. */
export function tileRasterDataset(
  dataset: DatasetConfig,
  area: Area,
  mosaic: Mosaic,
  folders: DatasetFolders,
  tilesAt?: (z: number) => Iterable<TileCoord>,
): { built: number; skipped: number } {
  return buildRasterTiles({
    area,
    ...(tilesAt ? { tilesAt } : {}),
    minZoom: dataset.minZoom,
    maxZoom: dataset.maxZoom,
    mosaic,
    rawFolder: join(folders.work, 'raw'),
    tileFolder: folders.tiles,
    extension: tileExtension(dataset),
    encode: rasterEncoder(dataset),
    // Terrain tiles carry a ring of their neighbors' heights, so neighbors' shared edges match (KB-178).
    borderPx: terrainBorderPx(dataset),
    log: folders.log,
    report: folders.report,
  });
}
