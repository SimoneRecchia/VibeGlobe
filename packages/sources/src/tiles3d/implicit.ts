// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * 3D Tiles implicit tiling (F460; ADR 0041): subtree files (binary `subt` or JSON) with tile, content and child-subtree
 * availability (bitstreams or constants), Morton indexing, and the expansion of an implicit tile into its available
 * children with subdivided bounding volumes, halved geometric errors and content URIs from the templates.
 */
import { propertyTableRow, type PropertyTable } from './metadata.js';
import type { ImplicitCoordinates, ImplicitTiling, Tile3D, TileContent } from './tileset.js';
import { worldVolume } from './volumes.js';

/** Availability: a constant, or one bit per index (least significant bit first). */
type Availability = { readonly constant: boolean } | { readonly bits: Uint8Array };

/** A parsed subtree. */
export interface Subtree {
  readonly tiles: Availability;
  readonly contents: readonly Availability[];
  readonly childSubtrees: Availability;
  /** The subtree's buffer views, for its property tables. */
  readonly views: readonly Uint8Array[];
  readonly propertyTables: readonly PropertyTable[];
  /** Index of the property table holding the metadata of the subtree's available tiles. */
  readonly tileMetadata?: number;
  /** Per content, the index of the property table holding the metadata of its available contents. */
  readonly contentMetadata: readonly (number | undefined)[];
  readonly subtreeMetadata?: Readonly<Record<string, unknown>>;
}

const decoder = new TextDecoder();

/** The number of available entries before `index` (the row of an available entry in its property table). */
function rank(a: Availability, index: number): number {
  if ('constant' in a) return index;
  let count = 0;
  for (let i = 0; i < index; i++) if (isAvailable(a, i)) count++;
  return count;
}

function isAvailable(a: Availability, index: number): boolean {
  if ('constant' in a) return a.constant;
  const byte = a.bits[index >> 3];
  return byte !== undefined && ((byte >> (index & 7)) & 1) === 1;
}

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

function availability(value: unknown, views: readonly Uint8Array[], bitCount: number, what: string): Availability {
  if (!isRecord(value)) throw new Error(`${what} is missing`);
  if (value['constant'] === 0 || value['constant'] === 1) return { constant: value['constant'] === 1 };
  const index = value['bitstream'] ?? value['bufferView'];
  const view = typeof index === 'number' ? views[index] : undefined;
  if (view === undefined) throw new Error(`${what} refers to a missing buffer view`);
  if (view.length * 8 < bitCount) throw new Error(`${what} bitstream is shorter than ${bitCount} bits`);
  return { bits: view };
}

function bufferViews(json: Json, binary: Uint8Array): Uint8Array[] {
  const buffers = Array.isArray(json['buffers']) ? json['buffers'] : [];
  if (buffers.some((b) => isRecord(b) && b['uri'] !== undefined))
    throw new Error('external subtree buffers are not supported');
  const views = Array.isArray(json['bufferViews']) ? json['bufferViews'] : [];
  return views.map((v) => {
    if (!isRecord(v)) throw new Error('malformed buffer view');
    const offset = Number(v['byteOffset'] ?? 0);
    const length = Number(v['byteLength']);
    if (
      v['buffer'] !== 0 ||
      !Number.isInteger(offset) ||
      !Number.isInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > binary.length
    ) {
      throw new Error('buffer view runs past the subtree binary');
    }
    return binary.subarray(offset, offset + length);
  });
}

/** Tiles in a subtree of `levels` levels for a branching factor `n` (4 quadtree, 8 octree). */
function tileCount(n: number, levels: number): number {
  return (n ** levels - 1) / (n - 1);
}

/**
 * Parses a subtree file for an implicit tiling. Never throws: a malformed subtree returns an error message (the tiles
 * it would add are left out and their parent stays drawn).
 */
export function parseSubtree(input: ArrayBuffer | Uint8Array, tiling: ImplicitTiling): Subtree | { error: string } {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  try {
    let json: Json;
    let binary: Uint8Array = new Uint8Array(0);
    if (bytes.length >= 24 && String.fromCharCode(...bytes.subarray(0, 4)) === 'subt') {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (view.getUint32(4, true) !== 1) throw new Error('subtree version must be 1');
      const jsonLength = Number(view.getBigUint64(8, true));
      const binaryLength = Number(view.getBigUint64(16, true));
      if (24 + jsonLength + binaryLength > bytes.length) throw new Error('subtree lengths run past the file');
      json = JSON.parse(decoder.decode(bytes.subarray(24, 24 + jsonLength)).replace(/[\0\s]+$/, '')) as Json;
      binary = bytes.subarray(24 + jsonLength, 24 + jsonLength + binaryLength);
    } else {
      json = JSON.parse(decoder.decode(bytes)) as Json;
    }
    if (!isRecord(json)) throw new Error('subtree JSON must be an object');
    const views = bufferViews(json, binary);
    const n = tiling.scheme === 'QUADTREE' ? 4 : 8;
    const tiles = tileCount(n, tiling.subtreeLevels);
    const extension = isRecord(json['extensions']) ? json['extensions']['3DTILES_multiple_contents'] : undefined;
    const rawContents =
      json['contentAvailability'] ?? (isRecord(extension) ? extension['contentAvailability'] : undefined);
    const contentList = Array.isArray(rawContents) ? rawContents : rawContents === undefined ? [] : [rawContents];
    return {
      tiles: availability(json['tileAvailability'], views, tiles, 'tileAvailability'),
      contents: contentList.map((c, i) => availability(c, views, tiles, `contentAvailability[${i}]`)),
      childSubtrees: availability(
        json['childSubtreeAvailability'],
        views,
        n ** tiling.subtreeLevels,
        'childSubtreeAvailability',
      ),
      views,
      propertyTables: Array.isArray(json['propertyTables']) ? (json['propertyTables'] as PropertyTable[]) : [],
      ...(typeof json['tileMetadata'] === 'number' ? { tileMetadata: json['tileMetadata'] } : {}),
      contentMetadata: Array.isArray(json['contentMetadata'])
        ? json['contentMetadata'].map((m) => (typeof m === 'number' ? m : undefined))
        : [],
      ...(isRecord(json['subtreeMetadata']) ? { subtreeMetadata: json['subtreeMetadata'] } : {}),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The Morton index of coordinates relative to a subtree root at a relative level. */
export function morton(x: number, y: number, z: number, octree: boolean): number {
  let index = 0;
  for (let bit = 0; bit < 21; bit++) {
    const shift = octree ? 3 * bit : 2 * bit;
    index += ((x >> bit) & 1) * 2 ** shift + ((y >> bit) & 1) * 2 ** (shift + 1);
    if (octree) index += ((z >> bit) & 1) * 2 ** (shift + 2);
  }
  return index;
}

/** Substitutes `{level}`, `{x}`, `{y}` and `{z}` in a template URI. */
export function expandTemplate(template: string, c: ImplicitCoordinates): string {
  return template
    .replaceAll('{level}', String(c.level))
    .replaceAll('{x}', String(c.x))
    .replaceAll('{y}', String(c.y))
    .replaceAll('{z}', String(c.z));
}

/** The bounding volume of an implicit tile, subdivided from the root's `box` or `region`. */
export function subdivideVolume(
  root: Readonly<Record<string, unknown>>,
  c: ImplicitCoordinates,
  octree: boolean,
): Record<string, unknown> | undefined {
  const parts = 2 ** c.level;
  const box = root['box'];
  const region = root['region'];
  if (Array.isArray(box) && box.length === 12) {
    const b = box as number[];
    const center = [0, 1, 2].map((i) => {
      const fx = ((2 * c.x + 1) / parts - 1) * (b[3 + i] ?? 0);
      const fy = ((2 * c.y + 1) / parts - 1) * (b[6 + i] ?? 0);
      const fz = octree ? ((2 * c.z + 1) / parts - 1) * (b[9 + i] ?? 0) : 0;
      return (b[i] ?? 0) + fx + fy + fz;
    });
    const half = (from: number, scaled: boolean) => [0, 1, 2].map((i) => (b[from + i] ?? 0) / (scaled ? parts : 1));
    return { box: [...center, ...half(3, true), ...half(6, true), ...half(9, octree)] };
  }
  if (Array.isArray(region) && region.length === 6) {
    const [west = 0, south = 0, east = 0, north = 0, minH = 0, maxH = 0] = region as number[];
    const w = (east - west) / parts;
    const s = (north - south) / parts;
    const h = octree ? (maxH - minH) / parts : maxH - minH;
    const low = octree ? minH + c.z * h : minH;
    return { region: [west + c.x * w, south + c.y * s, west + (c.x + 1) * w, south + (c.y + 1) * s, low, low + h] };
  }
  return undefined;
}

/** Where an implicit tile sits in its subtree. */
interface SubtreeSlot {
  readonly root: ImplicitCoordinates;
  readonly subtree: Subtree;
}

const slots = new WeakMap<Tile3D, SubtreeSlot>();

/** Attaches a loaded subtree to the implicit tile at its root. */
export function attachSubtree(tile: Tile3D, subtree: Subtree): void {
  if (tile.coordinates !== undefined) slots.set(tile, { root: tile.coordinates, subtree });
}

/** Whether this implicit tile is the root of a subtree that is not loaded yet (its subtree URI must be fetched). */
export function needsSubtree(tile: Tile3D): boolean {
  return tile.implicit !== undefined && tile.coordinates !== undefined && !slots.has(tile) && isSubtreeRoot(tile);
}

function isSubtreeRoot(tile: Tile3D): boolean {
  const levels = tile.implicit?.subtreeLevels ?? 1;
  return (tile.coordinates?.level ?? 0) % levels === 0;
}

/** The subtree URI of a subtree-root tile. */
export function subtreeUri(tile: Tile3D): string | undefined {
  return tile.implicit === undefined || tile.coordinates === undefined
    ? undefined
    : expandTemplate(tile.implicit.subtrees, tile.coordinates);
}

function row(subtree: Subtree, tiling: ImplicitTiling, table: number | undefined, index: number) {
  const propertyTable = table === undefined ? undefined : subtree.propertyTables[table];
  if (propertyTable === undefined || tiling.schema === undefined) return undefined;
  return propertyTableRow(propertyTable, index, subtree.views, tiling.schema);
}

function tileMetadata(tiling: ImplicitTiling, subtree: Subtree, relative: number): Record<string, unknown> | undefined {
  return row(subtree, tiling, subtree.tileMetadata, rank(subtree.tiles, relative));
}

function availableContents(
  tiling: ImplicitTiling,
  subtree: Subtree,
  c: ImplicitCoordinates,
  relative: number,
): TileContent[] {
  const out: TileContent[] = [];
  tiling.contents.forEach((template, i) => {
    const availability = subtree.contents[i];
    if (availability === undefined || !isAvailable(availability, relative)) return;
    const metadata = row(subtree, tiling, subtree.contentMetadata[i], rank(availability, relative));
    out.push({ uri: expandTemplate(template, c), external: false, ...(metadata === undefined ? {} : { metadata }) });
  });
  return out;
}

function makeTile(
  parent: Tile3D,
  tiling: ImplicitTiling,
  c: ImplicitCoordinates,
  slot: SubtreeSlot,
  relative: number | undefined,
): Tile3D | undefined {
  const octree = tiling.scheme === 'OCTREE';
  const declared = subdivideVolume(tiling.rootVolume, c, octree);
  const volume = declared === undefined ? undefined : worldVolume(declared, parent.transform);
  if (declared === undefined || volume === undefined) return undefined;
  const contents = relative === undefined ? [] : availableContents(tiling, slot.subtree, c, relative);
  const metadata = relative === undefined ? undefined : tileMetadata(tiling, slot.subtree, relative);
  const tile: Tile3D = {
    id: `${parent.id.split('@')[0] ?? parent.id}@${c.level}/${c.x}/${c.y}${octree ? `/${c.z}` : ''}`,
    parent,
    depth: parent.depth + 1,
    geometricError: tiling.rootGeometricError / 2 ** c.level,
    refine: parent.refine,
    transform: parent.transform,
    volume,
    boundingVolume: declared,
    contents,
    children: [],
    ...(metadata === undefined ? {} : { metadata }),
    implicit: tiling,
    coordinates: c,
    state: 'unloaded',
    bytes: 0,
  };
  if (relative !== undefined) slots.set(tile, slot);
  return tile;
}

/**
 * Creates the available children of an implicit tile from its subtree (once). Children that start a new subtree are
 * created when the subtree marks them available; their own content is known once their subtree is loaded
 * (`needsSubtree`).
 * @returns false when the tile's subtree is not loaded yet.
 */
export function expandImplicitChildren(tile: Tile3D): boolean {
  const tiling = tile.implicit;
  const c = tile.coordinates;
  const slot = slots.get(tile);
  if (tiling === undefined || c === undefined || slot === undefined) return false;
  if (tile.children.length > 0 || c.level + 1 >= tiling.availableLevels) return true;
  const octree = tiling.scheme === 'OCTREE';
  const n = octree ? 8 : 4;
  const relativeLevel = c.level + 1 - slot.root.level;
  for (let i = 0; i < n; i++) {
    const child = {
      level: c.level + 1,
      x: 2 * c.x + (i & 1),
      y: 2 * c.y + ((i >> 1) & 1),
      z: octree ? 2 * c.z + ((i >> 2) & 1) : 0,
    };
    const local = morton(
      child.x - slot.root.x * 2 ** relativeLevel,
      child.y - slot.root.y * 2 ** relativeLevel,
      child.z - slot.root.z * 2 ** relativeLevel,
      octree,
    );
    let created: Tile3D | undefined;
    if (relativeLevel < tiling.subtreeLevels) {
      const index = tileCount(n, relativeLevel) + local;
      if (isAvailable(slot.subtree.tiles, index)) created = makeTile(tile, tiling, child, slot, index);
    } else if (isAvailable(slot.subtree.childSubtrees, local)) {
      created = makeTile(tile, tiling, child, slot, undefined);
    }
    if (created !== undefined) tile.children.push(created);
  }
  return true;
}

/** Applies a loaded subtree to the subtree-root tile: its own content availability, then its children. */
export function applySubtree(tile: Tile3D, subtree: Subtree): void {
  attachSubtree(tile, subtree);
  const tiling = tile.implicit;
  const c = tile.coordinates;
  if (tiling === undefined || c === undefined) return;
  if (tile.contents.length === 0) (tile.contents as TileContent[]).push(...availableContents(tiling, subtree, c, 0));
  const metadata = tileMetadata(tiling, subtree, 0);
  if (metadata !== undefined) (tile as { metadata?: Readonly<Record<string, unknown>> }).metadata = metadata;
  expandImplicitChildren(tile);
}
