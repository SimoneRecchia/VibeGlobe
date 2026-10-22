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

/** Average encoded size of one tile of `dataset` at zoom `z`. */
function bytesPerTile(dataset: DatasetConfig, z: number): number {
  const value = dataset.bytesPerTile;
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
export function estimateDataset(dataset: DatasetConfig, area: Area, region: string): DatasetEstimate {
  const zooms: ZoomEstimate[] = [];
  for (let z = dataset.minZoom; z <= dataset.maxZoom; z++) {
    const tiles = areaTileCount(area, z);
    zooms.push({ z, tiles, bytes: tiles * bytesPerTile(dataset, z) });
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

/** A readable table of the estimate: per dataset, region and zoom level, then totals and cost. */
export function formatEstimate(estimate: BuildEstimate): string {
  const lines: string[] = ['Estimate (nothing has been downloaded):'];
  for (const d of estimate.datasets) {
    lines.push(`  ${d.dataset} [${d.region}]`);
    let previous: number | undefined;
    for (const zoom of d.zooms) {
      const growth = previous ? ` (×${(zoom.tiles / previous).toFixed(2)})` : '';
      lines.push(`    z${zoom.z}: ${zoom.tiles.toLocaleString('en')} tiles, ${formatBytes(zoom.bytes)}${growth}`);
      previous = zoom.tiles;
    }
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
