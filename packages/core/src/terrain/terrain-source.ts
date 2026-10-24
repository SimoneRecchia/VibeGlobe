// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { TileSource } from '../imagery/imagery-source.js';
import type { TileCoord } from '../tiling/tile-key.js';
import type { HeightGrid } from './heightmap.js';
import type { VerticalDatum } from './vertical-datum.js';

/**
 * How a terrain source's bytes become a height grid: one of the built-in decoders, which run in the worker pool
 * (F134), or a custom decode function of a third-party adapter (F132), a pure function of the bytes that the engine
 * runs in the inline executor between frames.
 */
export type TerrainDecoder =
  | { readonly kind: 'terrarium' | 'terrain-rgb' }
  | { readonly kind: 'quantized-mesh' }
  | {
      readonly kind: 'custom';
      /** Decodes a tile's bytes to heights in meters above the source's datum; throws on undecodable bytes. */
      decode(bytes: ArrayBuffer, coord: TileCoord): HeightGrid;
    };

/**
 * A tiled terrain source (docs/plan/api.md, M4 plan): where its tiles come from, how they are cut and decoded, and
 * what its heights are measured from. Adapters such as `terrariumTerrain` and `quantizedMeshTerrain` in
 * `@vibeglobe/sources` implement it; any other encoding implements it with a custom decoder (F132).
 */
export interface TerrainSource extends TileSource {
  readonly decoder: TerrainDecoder;
  /** What the heights are measured from; geoid heights are converted to ellipsoidal ones before meshing (F133). */
  readonly datum: VerticalDatum;
  /**
   * The geometric error of a level in meters: how far the source's surface at that level may be from the real one.
   * Selection refines a tile while this error exceeds τ_terrain pixels on screen (ADR 0006 §2, F126).
   */
  geometricErrorMeters(level: number): number;
  /**
   * Receives the metadata a decoded tile carries (quantized-mesh's metadata extension), for example the availability
   * of the levels below it (F128).
   */
  tileMetadata?(coord: TileCoord, metadata: unknown): void;
}

/**
 * The usual geometric error of a level: a quarter of the ground spacing between the samples of a tile of
 * `samplesPerSide` samples at that level on the equator (an estimate; ADR 0006 adds the measured decimation error).
 */
export function heightmapGeometricErrorMeters(
  level: number,
  samplesPerSide: number,
  equatorMeters: number,
  tilesAtLevel0: number,
): number {
  return (0.25 * equatorMeters) / (tilesAtLevel0 * samplesPerSide * 2 ** level);
}
