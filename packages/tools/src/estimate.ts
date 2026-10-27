// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Size and cost estimates computed before any download (F334, F552, F307): exact tile counts per zoom level, output
 * bytes from each dataset's measured average tile size, download bytes and requester-pays cost.
 */
import type { DatasetConfig, PricesConfig } from './config/schema.js';
import { sourceFiles } from './sources/files.js';
import { type Area, areaTileCount, coverage } from './tiles/area.js';

/** One zoom level of a dataset estimate. */
export interface ZoomEstimate {
  z: number;
  tiles: number;
  bytes: number;
  /** With a land mask: tiles touching land and tiles wholly at sea (0 beyond the sea's last zoom). */
  land?: number;
  sea?: number;
  /** Whether the tile sizes of this zoom were measured on a sample rather than taken from the configuration. */
  measured?: boolean;
}

/** Average tile sizes measured on a sample, by zoom: land tiles and sea tiles. */
export type MeasuredSizes = Record<number, { land?: number; sea?: number }>;

/** The land and sea split of a dataset's tiles (`LandMask`), as far as the estimate reads it. */
export interface LandSplit {
  landCount(z: number): number;
  seaCount(z: number): number;
}

/** The estimate of one dataset over one area. */
export interface DatasetEstimate {
  dataset: string;
  region: string;
  zooms: ZoomEstimate[];
  tiles: number;
  /** Bytes of one copy of the tiles. */
  tileBytes: number;
  /** Bytes written over every enabled output (static folder, PMTiles, MBTiles). */
  outputBytes: number;
  downloadFiles: number;
  downloadBytes: number;
  requesterPaysBytes: number;
  requesterPaysRequests: number;
}

/** Totals of a build estimate, with its cost. */
export interface BuildEstimate {
  datasets: DatasetEstimate[];
  tiles: number;
  outputBytes: number;
  downloadBytes: number;
  cost: number;
  currency: string;
  pricesReadDate: string;
}

/** Average encoded size of one tile of `dataset` at zoom `z` (over land, or at sea with `sea`). */
function bytesPerTile(dataset: DatasetConfig, z: number, sea = false): number {
  const value = (sea ? dataset.seaBytesPerTile : undefined) ?? dataset.bytesPerTile;
  if (typeof value === 'number') return value;
  const exact = value[String(z)];
  if (exact !== undefined) return exact;
  const zooms = Object.keys(value)
    .map(Number)
    .sort((a, b) => a - b);
  const nearest = zooms.reduce((best, zoom) => (Math.abs(zoom - z) < Math.abs(best - z) ? zoom : best), zooms[0] ?? z);
  return value[String(nearest)] ?? 0;
}

/** Estimates one dataset over an area. */
export function estimateDataset(
  dataset: DatasetConfig,
  area: Area,
  region: string,
  land?: LandSplit,
  measured: MeasuredSizes = {},
): DatasetEstimate {
  const zooms: ZoomEstimate[] = [];
  for (let z = dataset.minZoom; z <= dataset.maxZoom; z++) {
    const sample = measured[z];
    const landBytes = sample?.land ?? bytesPerTile(dataset, z);
    const seaBytes = sample?.sea ?? bytesPerTile(dataset, z, true);
    const isMeasured = sample !== undefined ? { measured: true } : {};
    if (land && dataset.seaMaxZoom !== undefined) {
      const onLand = land.landCount(z);
      const atSea = z <= dataset.seaMaxZoom ? land.seaCount(z) : 0;
      zooms.push({
        z,
        tiles: onLand + atSea,
        land: onLand,
        sea: atSea,
        bytes: onLand * landBytes + atSea * seaBytes,
        ...isMeasured,
      });
    } else {
      const tiles = areaTileCount(area, z);
      zooms.push({ z, tiles, bytes: tiles * landBytes, ...isMeasured });
    }
  }
  // The same files the build downloads: every source covering the area's tiles at the lowest zoom.
  const files = sourceFiles(dataset, { kind: 'bbox', bbox: coverage(area, dataset.minZoom) });
  const paid = files.filter((file) => file.requesterPays);
  const outputs = [dataset.outputs.static, dataset.outputs.pmtiles, dataset.outputs.mbtiles].filter(Boolean).length;
  const tileBytes = zooms.reduce((sum, zoom) => sum + zoom.bytes, 0);
  return {
    dataset: dataset.id,
    region,
    zooms,
    tiles: zooms.reduce((sum, zoom) => sum + zoom.tiles, 0),
    tileBytes,
    outputBytes: tileBytes * outputs,
    downloadFiles: files.length,
    // A windowed read (ADR 0026) transfers its share of the file.
    downloadBytes: Math.round(files.reduce((n, f) => n + (f.fraction ?? 1), 0) * dataset.downloadBytesPerFile),
    requesterPaysBytes: paid.length * dataset.downloadBytesPerFile,
    requesterPaysRequests: paid.length,
  };
}

const GB = 1e9;

/** Combines dataset estimates and prices them. */
export function totalEstimate(datasets: DatasetEstimate[], prices: PricesConfig): BuildEstimate {
  const sum = (pick: (d: DatasetEstimate) => number): number => datasets.reduce((total, d) => total + pick(d), 0);
  const paidBytes = sum((d) => d.requesterPaysBytes);
  const freeBytes = sum((d) => d.downloadBytes) - paidBytes;
  const cost =
    (paidBytes / GB) * prices.requesterPaysTransferPerGB +
    (sum((d) => d.requesterPaysRequests) / 1000) * prices.requesterPaysGetPer1000 +
    (freeBytes / GB) * prices.freeTransferPerGB;
  return {
    datasets,
    tiles: sum((d) => d.tiles),
    outputBytes: sum((d) => d.outputBytes),
    downloadBytes: sum((d) => d.downloadBytes),
    cost,
    currency: prices.currency,
    pricesReadDate: prices.readDate,
  };
}

/** Formats a byte count with a binary-free decimal unit (kB, MB, GB, TB). */
export function formatBytes(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** The rows of one dataset's table: per zoom, its tiles (land and sea when split), size and cumulative gigabytes. */
function zoomRows(d: DatasetEstimate): string[] {
  const split = d.zooms.some((z) => z.land !== undefined);
  const cells = (values: string[]): string =>
    `    ${values.map((v, i) => (i === 0 ? v.padEnd(5) : v.padStart(14))).join('')}`;
  const rows = [cells(['zoom', ...(split ? ['land tiles', 'sea tiles'] : []), 'tiles', 'size', 'cumulative', 'sizes'])];
  let cumulative = 0;
  for (const zoom of d.zooms) {
    cumulative += zoom.bytes;
    rows.push(
      cells([
        `z${zoom.z}`,
        ...(split ? [(zoom.land ?? 0).toLocaleString('en'), (zoom.sea ?? 0).toLocaleString('en')] : []),
        zoom.tiles.toLocaleString('en'),
        formatBytes(zoom.bytes),
        `${(cumulative / GB).toFixed(2)} GB`,
        zoom.measured ? 'measured' : 'configured',
      ]),
    );
  }
  return rows;
}

/** A readable table of the estimate: per dataset, region and zoom level, then totals and cost. */
export function formatEstimate(estimate: BuildEstimate): string {
  const lines: string[] = ['Estimate (nothing has been downloaded):'];
  for (const d of estimate.datasets) {
    lines.push(`  ${d.dataset} [${d.region}]`, ...zoomRows(d));
    lines.push(
      `    total: ${d.tiles.toLocaleString('en')} tiles, ${formatBytes(d.outputBytes)} written; ` +
        `download ${d.downloadFiles} files, ${formatBytes(d.downloadBytes)}`,
    );
  }
  lines.push(
    `Totals: ${estimate.tiles.toLocaleString('en')} tiles, output ${formatBytes(estimate.outputBytes)}, ` +
      `download ${formatBytes(estimate.downloadBytes)}`,
    `Estimated cost: ${estimate.cost.toFixed(2)} ${estimate.currency} ` +
      `(requester-pays transfer and requests; prices read ${estimate.pricesReadDate})`,
  );
  return lines.join('\n');
}
