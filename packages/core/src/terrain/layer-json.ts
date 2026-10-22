/**
 * The `layer.json` of a quantized-mesh terrain source (F128): its tiling scheme, zoom range, tile URL templates,
 * declared extensions and availability, whether listed in full or spread over child tiles (`metadataAvailability`).
 * Pure functions; invalid documents throw a `TypeError` naming the field.
 */

/** A rectangle of available tiles at one level, inclusive, with y counted from the south (TMS). */
export interface TileRange {
  readonly startX: number;
  readonly startY: number;
  readonly endX: number;
  readonly endY: number;
}

/** What a terrain source's `layer.json` declares. */
export interface TerrainLayer {
  readonly scheme: 'geographic' | 'mercator';
  readonly minZoom: number;
  readonly maxZoom: number;
  /** URL templates with `{z}`, `{x}`, `{y}` and `{version}`, relative to the `layer.json`. */
  readonly tiles: readonly string[];
  readonly version: string;
  readonly extensions: readonly string[];
  /**
   * Levels between child-tile availability metadata (`metadataAvailability`), or 0 when the document lists all of it.
   */
  readonly metadataEvery: number;
  /** Availability per level; levels beyond the list are learned from tile metadata. */
  readonly available: readonly (readonly TileRange[])[];
}

function integer(value: unknown, field: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min)
    throw new TypeError(`layer.json: ${field} must be an integer of at least ${min}`);
  return value;
}

/** Reads availability ranges, as in `layer.json` (`available`) and in the metadata extension of tiles. */
export function readRanges(value: unknown, field: string): TileRange[][] {
  if (!Array.isArray(value)) throw new TypeError(`layer.json: ${field} must be an array`);
  return value.map((level: unknown, z) => {
    if (!Array.isArray(level)) throw new TypeError(`layer.json: ${field}[${z}] must be an array`);
    return level.map((range: unknown) => {
      const r = range as Record<string, unknown>;
      const startX = integer(r?.['startX'], `${field}[${z}].startX`);
      const startY = integer(r?.['startY'], `${field}[${z}].startY`);
      const endX = integer(r?.['endX'], `${field}[${z}].endX`);
      const endY = integer(r?.['endY'], `${field}[${z}].endY`);
      if (endX < startX || endY < startY) throw new TypeError(`layer.json: ${field}[${z}] has an empty range`);
      return { startX, startY, endX, endY };
    });
  });
}

/** Parses a `layer.json` document (already parsed from JSON). */
export function readLayerJson(document: unknown): TerrainLayer {
  if (typeof document !== 'object' || document === null) throw new TypeError('layer.json: not an object');
  const d = document as Record<string, unknown>;
  if (d['format'] !== undefined && d['format'] !== 'quantized-mesh-1.0')
    throw new TypeError(`layer.json: unsupported format ${String(d['format'])}`);
  const projection = d['projection'] ?? 'EPSG:4326';
  if (projection !== 'EPSG:4326' && projection !== 'EPSG:3857')
    throw new TypeError(`layer.json: unsupported projection ${String(projection)}`);
  const tiles = d['tiles'];
  if (!Array.isArray(tiles) || tiles.length === 0 || !tiles.every((t) => typeof t === 'string'))
    throw new TypeError('layer.json: tiles must list URL templates');
  const minZoom = integer(d['minzoom'] ?? 0, 'minzoom');
  const maxZoom = integer(d['maxzoom'] ?? 30, 'maxzoom', minZoom);
  const extensions = d['extensions'] ?? [];
  if (!Array.isArray(extensions) || !extensions.every((e) => typeof e === 'string'))
    throw new TypeError('layer.json: extensions must be strings');
  return {
    scheme: projection === 'EPSG:3857' ? 'mercator' : 'geographic',
    minZoom,
    maxZoom,
    tiles: tiles as string[],
    version: typeof d['version'] === 'string' ? d['version'] : '1.0.0',
    extensions: extensions as string[],
    metadataEvery:
      d['metadataAvailability'] === undefined ? 0 : integer(d['metadataAvailability'], 'metadataAvailability', 1),
    available: d['available'] === undefined ? [] : readRanges(d['available'], 'available'),
  };
}

/**
 * Availability of a terrain source, filled from `layer.json` and from the metadata of loaded tiles. A tile is
 * `available`, `unavailable`, or `unknown` until the metadata tile that covers it has loaded.
 */
export class TerrainAvailability {
  private readonly levels: TileRange[][];

  constructor(private readonly layer: TerrainLayer) {
    this.levels = layer.available.map((ranges) => [...ranges]);
  }

  /** Adds the availability a tile's metadata extension declares for the levels below it, starting at `level`. */
  addFromMetadata(level: number, ranges: readonly (readonly TileRange[])[]): void {
    ranges.forEach((list, i) => {
      const z = level + i;
      while (this.levels.length <= z) this.levels.push([]);
      this.levels[z]?.push(...list);
    });
  }

  /** Whether tile (z, x, y) exists, with y counted from the north (the engine's convention). */
  status(z: number, x: number, yFromNorth: number): 'available' | 'unavailable' | 'unknown' {
    if (z < this.layer.minZoom || z > this.layer.maxZoom) return 'unavailable';
    // Both schemes have 2^z rows (the geographic one has twice as many columns).
    const y = 2 ** z - 1 - yFromNorth;
    const ranges = this.levels[z];
    if (ranges?.some((r) => x >= r.startX && x <= r.endX && y >= r.startY && y <= r.endY)) return 'available';
    // Levels the document lists are complete; deeper ones are complete only without metadata spread over tiles,
    // otherwise a missing range may still come with the metadata tile that covers it.
    if (this.layer.metadataEvery === 0 || z < this.layer.available.length) return 'unavailable';
    return 'unknown';
  }
}
