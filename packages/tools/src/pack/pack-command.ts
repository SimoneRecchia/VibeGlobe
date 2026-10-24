// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** The `pack` command: arguments, estimate, confirmation, download and package. */
import { readFileSync } from 'node:fs';
import type { CliIo, ParsedArgs } from '../cli.js';
import { formatBytes } from '../estimate.js';
import { type Area, type Ring, polygonArea } from '../tiles/area.js';
import { parseBBox } from '../tiles/mercator.js';
import { type PackRequest, estimatePack, fetchPackTiles, gatePack, writePack } from './pack.js';

function required(parsed: ParsedArgs, name: string): string {
  const value = parsed.options.get(name);
  if (typeof value !== 'string' || value === '') throw new Error(`pack: --${name} is required`);
  return value;
}

function parseArea(parsed: ParsedArgs): Area {
  const bbox = parsed.options.get('bbox');
  if (typeof bbox === 'string') return { kind: 'bbox', bbox: parseBBox(bbox) };
  const json = JSON.parse(readFileSync(required(parsed, 'polygon'), 'utf8')) as Record<string, unknown>;
  const geometry = (json['type'] === 'Feature' ? json['geometry'] : json) as { type?: string; coordinates?: Ring[] };
  if (geometry.type !== 'Polygon' || !geometry.coordinates)
    throw new Error('pack: --polygon must be a GeoJSON Polygon');
  return polygonArea(geometry.coordinates);
}

/** Parses a pack request from CLI options. */
function packRequest(parsed: ParsedArgs, io: CliIo): PackRequest {
  const [min, max] = required(parsed, 'zooms').split('-').map(Number);
  if (!Number.isInteger(min) || !Number.isInteger(max) || (min ?? 0) < 0 || (max ?? 0) > 22 || (min ?? 0) > (max ?? 0))
    throw new Error('pack: --zooms must be <min>-<max> with 0 ≤ min ≤ max ≤ 22');
  const format = parsed.options.get('format') ?? 'pmtiles';
  if (format !== 'pmtiles' && format !== 'mbtiles') throw new Error('pack: --format must be pmtiles or mbtiles');
  const out = required(parsed, 'out');
  return {
    source: required(parsed, 'source'),
    profile: required(parsed, 'profile'),
    area: parseArea(parsed),
    minZoom: min as number,
    maxZoom: max as number,
    format,
    out,
    workFolder: String(parsed.options.get('work') ?? `${out}.work`),
    fetch: io.fetch,
    report: io.out,
  };
}

/** Runs the pack command; returns the exit code. */
export async function runPack(parsed: ParsedArgs, io: CliIo): Promise<number> {
  const request = packRequest(parsed, io);
  gatePack(request);
  const estimate = await estimatePack(request);
  io.out('Estimate (no tile has been downloaded; sizes probed with HEAD requests):');
  for (const zoom of estimate.zooms)
    io.out(`  z${zoom.z}: ${zoom.tiles.toLocaleString('en')} tiles, ${formatBytes(zoom.bytes)}`);
  io.out(`  total: ${estimate.tiles.toLocaleString('en')} tiles, ${formatBytes(estimate.bytes)}`);
  if (parsed.options.has('estimate-only')) return 0;
  if (!parsed.options.has('yes')) {
    if (!io.interactive)
      throw new Error('Not confirmed: non-interactive runs must pass --yes. Nothing was downloaded.');
    if (!(await io.ask('Download and build the package? [y/N] '))) {
      io.out('Cancelled: nothing was downloaded or written.');
      return 0;
    }
  }
  const files = await fetchPackTiles(request);
  writePack(request, files, (path) => new Uint8Array(readFileSync(path)));
  return 0;
}
