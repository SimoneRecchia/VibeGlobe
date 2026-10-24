/**
 * Draping vector tiles on the terrain (F452, ADR 0131): the terrain height under every vertex, from the terrain in
 * memory (`Globe.elevationAt`, interpolated as the surface shows it). Heights are exact per vertex, so the vertices two
 * tiles share on their common edge (fills and backgrounds are split on a grid aligned with the tile edges) get the
 * same height and the tiles meet without a seam. When the terrain uploads new tiles, meshes are draped again within
 * a time budget per frame, so draped features follow the relief as it refines without stalling a frame.
 */
import type { ElevationSample, GeoPosition } from '@vibeglobe/core';
import { tileToLonLat } from './globe-vertices.js';
import { BUCKET_EXTENT } from './layout-tile.js';
import type { TileId } from './tile-pyramid.js';

/** Main-thread time per frame for draping meshes. */
const BUDGET_MS = 4;

/** What draping reads from the globe. */
export interface TerrainView {
  elevationAt(position: GeoPosition, out?: ElevationSample): ElevationSample;
  terrainStats(): { readonly uploads: number } | undefined;
}

/** Terrain heights of vertices, with the terrain's version and the frame's time budget. */
export class TileGrounds {
  private readonly sample: ElevationSample = { heightMeters: 0, level: -1, noData: true };
  private readonly lonLat = [0, 0];
  private readonly position = { longitudeDeg: 0, latitudeDeg: 0 };
  private deadline = 0;
  /** The terrain's upload count: draped heights are current when made at this version. */
  version = 0;

  constructor(
    private readonly terrain: TerrainView,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Starts a frame: reads the terrain's version and opens the frame's budget. */
  frame(): void {
    this.version = this.terrain.terrainStats()?.uploads ?? 0;
    this.deadline = this.now() + BUDGET_MS;
  }

  /** Whether the globe has terrain at all. */
  get active(): boolean {
    return this.terrain.terrainStats() !== undefined;
  }

  /** Whether the frame's budget allows draping another mesh. */
  get canDrape(): boolean {
    return this.now() < this.deadline;
  }

  /** Writes the terrain height under each vertex (tile units, two per vertex) into `out`; 0 without terrain. */
  heights(tile: TileId, xy: Float32Array, out: Float32Array): Float32Array {
    if (!this.active) return out.fill(0);
    for (let v = 0; v < out.length; v++) {
      tileToLonLat(tile, BUCKET_EXTENT, xy[v * 2] ?? 0, xy[v * 2 + 1] ?? 0, this.lonLat);
      this.position.longitudeDeg = (((((this.lonLat[0] ?? 0) + 180) % 360) + 360) % 360) - 180;
      this.position.latitudeDeg = this.lonLat[1] ?? 0;
      out[v] = this.terrain.elevationAt(this.position, this.sample).heightMeters;
    }
    return out;
  }
}
