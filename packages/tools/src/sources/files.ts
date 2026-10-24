// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** The source files a dataset build downloads, computed from its area without touching the network. */
import type { CopernicusDemSource, DatasetConfig, S2CloudlessSource, WorldCoverSource } from '../config/schema.js';
import { type Area, intersectBBox } from '../tiles/area.js';
import type { BBoxDeg } from '../tiles/mercator.js';

/** One file to download. */
export interface SourceFile {
  url: string;
  /** Path of the file inside the build's download folder. */
  key: string;
  /** Geographic extent covered by the file, when known. */
  bounds?: BBoxDeg;
  /** Whether the request must be signed and is billed to the requester. */
  requesterPays: boolean;
  /** A missing file (HTTP 404) is expected and means "no data" (Copernicus DEM has no tiles over the ocean). */
  mayBeMissing: boolean;
  /** Read only this window of a cloud-optimized GeoTIFF, at an overview level (0 = full resolution). */
  window?: { bbox: BBoxDeg; level: number };
  /** Share of the full file the download reads (window area and overview level), for the estimate. */
  fraction?: number;
  /** For a WorldCover land-cover window: the key of the composite window whose gaps it fills. */
  gapMapFor?: string;
}

/** Bytes of a 3° WorldCover map over those of a 1° composite, per area (about 106 MB / 9 against 570 MB). */
const MAP_BYTES_RATIO = 0.021;

function pad(value: number, width: number): string {
  return String(Math.abs(value)).padStart(width, '0');
}

/** Name of the Copernicus DEM COG (GLO-30 or GLO-90) whose south-west corner is at integer `lat`, `lon`. */
export function copernicusDemName(lat: number, lon: number, arcSeconds: 1 | 3 = 1): string {
  const ns = `${lat >= 0 ? 'N' : 'S'}${pad(lat, 2)}_00`;
  const ew = `${lon >= 0 ? 'E' : 'W'}${pad(lon, 3)}_00`;
  return `Copernicus_DSM_COG_${arcSeconds === 3 ? 30 : 10}_${ns}_${ew}_DEM`;
}

function copernicusFiles(source: CopernicusDemSource, bbox: BBoxDeg): SourceFile[] {
  const files: SourceFile[] = [];
  for (let lat = Math.floor(bbox.south); lat < bbox.north; lat++) {
    for (let lon = Math.floor(bbox.west); lon < bbox.east; lon++) {
      const name = copernicusDemName(lat, lon, source.arcSeconds);
      files.push({
        url: `${source.baseUrl.replace(/\/$/, '')}/${name}/${name}.tif`,
        key: `${name}.tif`,
        bounds: { west: lon, south: lat, east: lon + 1, north: lat + 1 },
        requesterPays: false,
        mayBeMissing: true,
      });
    }
  }
  return files;
}

/**
 * Extent of one Sentinel-2 cloudless original file at `level`: the files are 2×2 metatiles of the EPSG:4326
 * WMTS-simple grid (level L has 2^(L+1) × 2^L tiles of 256 px), indexed by the column and row of level L − 1.
 */
export function s2FileExtentDeg(level: number): number {
  return 180 / 2 ** (level - 1);
}

function s2Files(source: S2CloudlessSource, bbox: BBoxDeg): SourceFile[] {
  const extent = s2FileExtentDeg(source.level);
  const files: SourceFile[] = [];
  const col0 = Math.floor((bbox.west + 180) / extent);
  const col1 = Math.ceil((bbox.east + 180) / extent) - 1;
  const row0 = Math.floor((90 - bbox.north) / extent);
  const row1 = Math.ceil((90 - bbox.south) / extent) - 1;
  for (let row = row0; row <= row1; row++) {
    for (let col = col0; col <= col1; col++) {
      const key = `tiles/${source.level}/${col}/${row}.tif`;
      files.push({
        url: `${source.baseUrl.replace(/\/$/, '')}/${key}`,
        key,
        bounds: {
          west: col * extent - 180,
          east: (col + 1) * extent - 180,
          north: 90 - row * extent,
          south: 90 - (row + 1) * extent,
        },
        requesterPays: source.requesterPays,
        mayBeMissing: false,
      });
    }
  }
  return files;
}

/** The ESA WorldCover composite cells (1°, named by their south-west corner) a box needs, read as windows. */
function worldCoverFiles(source: WorldCoverSource, bbox: BBoxDeg): SourceFile[] {
  const files: SourceFile[] = [];
  for (let lat = Math.floor(bbox.south); lat < bbox.north; lat++) {
    for (let lon = Math.floor(bbox.west); lon < bbox.east; lon++) {
      const cell = { west: lon, south: lat, east: lon + 1, north: lat + 1 };
      const window = intersectBBox(cell, bbox);
      if (!window) continue;
      const ns = `${lat >= 0 ? 'N' : 'S'}${pad(lat, 2)}`;
      const name = `ESA_WorldCover_10m_${source.year}_${source.version}_${ns}${lon >= 0 ? 'E' : 'W'}${pad(lon, 3)}_S2RGBNIR`;
      const area = (window.east - window.west) * (window.north - window.south);
      const corners = [window.west, window.south, window.east, window.north].map((v) => v.toFixed(6)).join('_');
      files.push({
        url: `${source.baseUrl.replace(/\/$/, '')}/rgbnir/${source.year}/${ns}/${name}.tif`,
        key: `${name}_L${source.overview}_${corners}.tif`,
        bounds: cell,
        requesterPays: false,
        // WorldCover has no file for cells without land.
        mayBeMissing: true,
        window: { bbox: window, level: source.overview },
        fraction: area / 4 ** source.overview,
      });
      if (!source.gapFill) continue;
      // The maps are 3° × 3° cells named by their south-west corner.
      const mapLat = Math.floor(lat / 3) * 3;
      const mapLon = Math.floor(lon / 3) * 3;
      const mapName = `ESA_WorldCover_10m_${source.year}_${source.version}_${mapLat >= 0 ? 'N' : 'S'}${pad(mapLat, 2)}${mapLon >= 0 ? 'E' : 'W'}${pad(mapLon, 3)}_Map`;
      files.push({
        url: `${source.gapFill.mapBaseUrl.replace(/\/$/, '')}/${source.version}/${source.year}/map/${mapName}.tif`,
        key: `${mapName}_L${source.overview}_${corners}.tif`,
        bounds: window,
        requesterPays: false,
        mayBeMissing: true,
        window: { bbox: window, level: source.overview },
        fraction: (area / 4 ** source.overview) * MAP_BYTES_RATIO,
        gapMapFor: `${name}_L${source.overview}_${corners}.tif`,
      });
    }
  }
  return files;
}

function fileName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? 'source');
}

/** The files a dataset needs for an area; XYZ sources have none (tiles are fetched while packaging). */
export function sourceFiles(dataset: DatasetConfig, area: Area): SourceFile[] {
  const source = dataset.source;
  switch (source.type) {
    case 'copernicus-dem': {
      const bbox = intersectBBox(area.bbox, { west: -180, south: -90, east: 180, north: 90 });
      return bbox ? copernicusFiles(source, bbox) : [];
    }
    case 's2cloudless':
      return s2Files(source, area.bbox);
    case 'worldcover-s2': {
      const bbox = intersectBBox(area.bbox, { west: -180, south: -90, east: 180, north: 90 });
      return bbox ? worldCoverFiles(source, bbox) : [];
    }
    case 'geotiff':
    case 'osm-extract':
      return [{ url: source.url, key: fileName(source.url), requesterPays: false, mayBeMissing: false }];
    case 'xyz':
      return [];
  }
}
