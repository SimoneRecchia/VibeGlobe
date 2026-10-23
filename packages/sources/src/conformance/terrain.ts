import {
  decodeHeightmap,
  heightGrid,
  sampleHeight,
  type HeightGrid,
  type TerrainSource,
  type TileCoord,
} from '@vibeglobe/core';
import { decodeQuantizedMesh, rasterizeQuantizedMesh } from '@vibeglobe/core/decoders';
import { check, type CheckResult } from './support.js';
import { describe, fetchTile, runSharedChecks, sourceMetadataChecks, type TiledConformanceSubject } from './tiled.js';

/** A height the fixture has at a point of a tile, with the tolerance of its encoding. */
export interface ReferenceHeight {
  readonly coord: TileCoord;
  /** From the tile's west edge (0) to its east edge (1). */
  readonly u: number;
  /** From the tile's north edge (0) to its south edge (1). */
  readonly v: number;
  readonly meters: number;
  /** The encoding's precision plus the interpolation between samples, meters. */
  readonly toleranceMeters: number;
}

/**
 * A terrain source under the shared suite (F235): the tiled checks (metadata, addressing, coverage, zoom range, error
 * handling, cancellation, attribution, profile) plus the decoded heights at reference points.
 */
export interface TerrainConformanceSubject extends TiledConformanceSubject<TerrainSource> {
  readonly heights: readonly ReferenceHeight[];
  /**
   * Decodes a heightmap tile's image bytes to RGBA (the browser's image decoder in the engine); needed for the
   * Terrarium and Terrain-RGB encodings only.
   */
  readonly decodeImage?: (bytes: Uint8Array) => { readonly rgba: Uint8Array; readonly sizePx: number };
}

/** Cells of the grid a quantized-mesh tile is rasterized to for the height checks. */
const MESH_CELLS = 64;

/** The tile's heights as the engine's decoders produce them. */
function decodeTile(source: TerrainSource, subject: TerrainConformanceSubject, bytes: ArrayBuffer, coord: TileCoord) {
  const decoder = source.decoder;
  if (decoder.kind === 'custom') return decoder.decode(bytes, coord);
  if (decoder.kind === 'quantized-mesh')
    return rasterizeQuantizedMesh(decodeQuantizedMesh(new Uint8Array(bytes)), MESH_CELLS);
  if (!subject.decodeImage) throw new Error('the subject gives no image decoder for a heightmap source');
  const image = subject.decodeImage(new Uint8Array(bytes));
  return heightGrid(decodeHeightmap(image.rgba, image.sizePx, decoder.kind), image.sizePx, image.sizePx);
}

function terrainMetadataChecks(source: TerrainSource): CheckResult[] {
  const errors = [source.minLevel, source.maxLevel].map((level) => source.geometricErrorMeters(level));
  const [coarse = 0, fine = 0] = errors;
  return [
    ...sourceMetadataChecks(source),
    check(
      'metadata',
      'declares its decoder',
      ['terrarium', 'terrain-rgb', 'quantized-mesh', 'custom'].includes(source.decoder.kind),
    ),
    check('metadata', 'declares its vertical datum', source.datum.kind.length > 0),
    check(
      'metadata',
      'declares a positive geometric error that shrinks with the level',
      coarse > 0 && fine > 0 && (source.minLevel === source.maxLevel || fine < coarse),
      errors.join(' → '),
    ),
  ];
}

async function heightChecks(source: TerrainSource, subject: TerrainConformanceSubject): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const grids = new Map<string, HeightGrid | string>();
  for (const reference of subject.heights) {
    const key = `${reference.coord.root}/${reference.coord.level}/${reference.coord.x}/${reference.coord.y}`;
    let grid = grids.get(key);
    if (grid === undefined) {
      const { result } = await fetchTile(source, reference.coord);
      if (result === 'noData' || result.kind !== 'ok') grid = describe(result);
      else {
        try {
          grid = decodeTile(source, subject, result.bytes, reference.coord);
        } catch (error) {
          grid = `undecodable: ${String(error)}`;
        }
      }
      grids.set(key, grid);
    }
    const name = `decodes ${key} at (${reference.u}, ${reference.v}) to ${reference.meters.toFixed(2)} m`;
    if (typeof grid === 'string') {
      out.push(check('heights', name, false, grid));
      continue;
    }
    const meters = sampleHeight(grid, reference.u, reference.v);
    out.push(
      check(
        'heights',
        name,
        Math.abs(meters - reference.meters) <= reference.toleranceMeters,
        `${meters.toFixed(2)} m`,
      ),
    );
  }
  return out;
}

/** Runs the shared suite against a terrain source and returns every check with its outcome (F235). */
export async function runTerrainConformance(subject: TerrainConformanceSubject): Promise<CheckResult[]> {
  const source = await subject.create(subject.fixture);
  const shared = await runSharedChecks(subject, source, terrainMetadataChecks(source));
  const heights = (await heightChecks(source, subject)).map((r) => ({ ...r, subject: subject.name }));
  return [...shared, ...heights];
}
