/**
 * OGC 3D Tiles 1.0 and 1.1 tileset JSON (F460; ADR 0034): the tile tree with world transforms, bounding volumes,
 * geometric errors, inherited refinement, single and multiple contents, external tilesets, implicit tiling roots
 * (1.1 `implicitTiling` and the 1.0 `3DTILES_implicit_tiling` extension) and metadata. Parsing treats the JSON as
 * untrusted: a malformed tile is reported and left out with its subtree, the rest of the tree is kept, and parsing
 * never throws.
 */
import { IDENTITY, multiply, worldVolume, type Mat4, type WorldVolume } from './volumes.js';

/** A problem found while parsing, with its JSON path. */
export interface TilesetProblem {
  readonly path: string;
  readonly message: string;
}

/** One content of a tile, its URI resolved against the tileset's URL. */
export interface TileContent {
  readonly uri: string;
  /** A content that is itself a tileset (external tileset). */
  readonly external: boolean;
  readonly volume?: WorldVolume;
  readonly group?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Implicit tiling of a subtree root (specification 1.1). */
export interface ImplicitTiling {
  readonly scheme: 'QUADTREE' | 'OCTREE';
  readonly subtreeLevels: number;
  readonly availableLevels: number;
  /** The subtree URI template with `{level}`, `{x}`, `{y}` (and `{z}`), resolved against the tileset URL. */
  readonly subtrees: string;
  /** The content URI templates, resolved. */
  readonly contents: readonly string[];
  /** The root's own bounding volume, as declared (subdivided for descendants). */
  readonly rootVolume: Readonly<Record<string, unknown>>;
  readonly rootGeometricError: number;
}

/** The coordinates of an implicit tile. */
export interface ImplicitCoordinates {
  readonly level: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Runtime state of a tile's content. */
export type ContentState = 'unloaded' | 'loading' | 'ready' | 'failed';

/** A tile of the tree. */
export interface Tile3D {
  readonly id: string;
  readonly parent: Tile3D | undefined;
  readonly depth: number;
  readonly geometricError: number;
  readonly refine: 'REPLACE' | 'ADD';
  /** World transform (the product of every ancestor's `transform`), column-major. */
  readonly transform: Mat4;
  readonly volume: WorldVolume;
  /** The declared bounding volume (implicit tiling subdivides it). */
  readonly boundingVolume: Readonly<Record<string, unknown>>;
  readonly viewerRequestVolume?: WorldVolume;
  readonly contents: readonly TileContent[];
  readonly children: Tile3D[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Present on the root of an implicit tree and on its generated descendants. */
  readonly implicit?: ImplicitTiling;
  readonly coordinates?: ImplicitCoordinates;
  /** Mutable runtime state, kept by the loader and read by traversal. */
  state: ContentState;
  /** Bytes the loaded content takes (GPU and RAM), set by the loader. */
  bytes: number;
}

/** A parsed tileset. */
export interface Tileset {
  readonly version: string;
  readonly geometricError: number;
  readonly root: Tile3D;
  readonly schema?: Readonly<Record<string, unknown>>;
  readonly schemaUri?: string;
  readonly groups?: readonly unknown[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly extensionsRequired: readonly string[];
}

/** Extensions this parser implements. A tileset that requires another one is refused, as the specification says. */
export const SUPPORTED_EXTENSIONS: readonly string[] = [
  '3DTILES_implicit_tiling',
  '3DTILES_multiple_contents',
  '3DTILES_metadata',
  '3DTILES_content_gltf',
  '3DTILES_bounding_volume_S2',
];

/** Bounds on untrusted input. */
const MAX_TILES = 1_000_000;
const MAX_DEPTH = 64;

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Resolves a URI against the tileset URL (which may itself be relative). */
export function resolveUri(uri: string, base: string): string {
  try {
    return new URL(uri, base).href;
  } catch {
    if (/^[a-z][a-z0-9+.-]*:|^\//i.test(uri)) return uri;
    const slash = base.lastIndexOf('/');
    return slash < 0 ? uri : `${base.slice(0, slash + 1)}${uri}`;
  }
}

function matrix(value: unknown): Mat4 | undefined {
  return Array.isArray(value) && value.length === 16 && value.every(isFiniteNumber) ? value : undefined;
}

interface Context {
  readonly base: string;
  readonly problems: TilesetProblem[];
  count: number;
}

function parseContents(json: Json, path: string, transform: Mat4, ctx: Context): TileContent[] {
  const multiple = (json['contents'] ??
    (isRecord(json['extensions']) && isRecord(json['extensions']['3DTILES_multiple_contents'])
      ? json['extensions']['3DTILES_multiple_contents']['contents']
      : undefined)) as unknown;
  const list = Array.isArray(multiple) ? multiple : json['content'] === undefined ? [] : [json['content']];
  const out: TileContent[] = [];
  list.forEach((content, i) => {
    const uri = isRecord(content) ? (content['uri'] ?? content['url']) : undefined;
    if (typeof uri !== 'string' || uri === '') {
      ctx.problems.push({
        path: `${path}.content${Array.isArray(multiple) ? `s[${i}]` : ''}`,
        message: 'content has no uri',
      });
      return;
    }
    const c = content as Json;
    const volume = c['boundingVolume'] === undefined ? undefined : worldVolume(c['boundingVolume'], transform);
    const resolved = resolveUri(uri, ctx.base);
    out.push({
      uri: resolved,
      external: /\.json($|\?)/i.test(uri),
      ...(volume === undefined ? {} : { volume }),
      ...(isFiniteNumber(c['group']) ? { group: c['group'] } : {}),
      ...(isRecord(c['metadata']) ? { metadata: c['metadata'] } : {}),
    });
  });
  return out;
}

function parseImplicit(json: Json, contents: readonly TileContent[], ctx: Context): ImplicitTiling | undefined {
  const raw =
    json['implicitTiling'] ??
    (isRecord(json['extensions']) ? json['extensions']['3DTILES_implicit_tiling'] : undefined);
  if (!isRecord(raw)) return undefined;
  const scheme = raw['subdivisionScheme'];
  const subtrees = isRecord(raw['subtrees']) ? (raw['subtrees']['uri'] ?? raw['subtrees']['url']) : undefined;
  const subtreeLevels = raw['subtreeLevels'];
  const availableLevels = raw['availableLevels'] ?? raw['maximumLevel'];
  if (
    (scheme !== 'QUADTREE' && scheme !== 'OCTREE') ||
    typeof subtrees !== 'string' ||
    !isFiniteNumber(subtreeLevels) ||
    subtreeLevels < 1 ||
    !isFiniteNumber(availableLevels) ||
    availableLevels < 1
  ) {
    ctx.problems.push({
      path: 'implicitTiling',
      message: 'implicit tiling needs a scheme, subtree levels, available levels and a subtree uri',
    });
    return undefined;
  }
  return {
    scheme,
    subtreeLevels: Math.min(subtreeLevels, MAX_DEPTH),
    availableLevels: Math.min(availableLevels, MAX_DEPTH),
    subtrees: resolveTemplate(subtrees, ctx.base),
    contents: contents.map((c) => decodeURIComponent(c.uri)),
    rootVolume: json['boundingVolume'] as Json,
    rootGeometricError: json['geometricError'] as number,
  };
}

/** Resolves a template URI while keeping its `{level}`-style placeholders readable. */
function resolveTemplate(uri: string, base: string): string {
  return decodeURIComponent(resolveUri(uri, base));
}

interface ParentInfo {
  readonly tile: Tile3D | undefined;
  readonly transform: Mat4;
  readonly refine: 'REPLACE' | 'ADD';
  readonly depth: number;
}

function parseTile(json: unknown, path: string, parent: ParentInfo, ctx: Context): Tile3D | undefined {
  if (!isRecord(json)) return problem(ctx, path, 'a tile must be an object');
  if (++ctx.count > MAX_TILES || parent.depth > MAX_DEPTH) return problem(ctx, path, 'tile tree too large or too deep');
  const local = json['transform'] === undefined ? IDENTITY : matrix(json['transform']);
  if (local === undefined) return problem(ctx, `${path}.transform`, 'transform must be 16 finite numbers');
  const transform = local === IDENTITY ? parent.transform : multiply(parent.transform, local);
  const volume = worldVolume(json['boundingVolume'], transform);
  if (volume === undefined) return problem(ctx, `${path}.boundingVolume`, 'missing or malformed bounding volume');
  const geometricError = json['geometricError'];
  if (!isFiniteNumber(geometricError) || geometricError < 0) {
    return problem(ctx, `${path}.geometricError`, 'geometricError must be a non-negative number');
  }
  const refineValue = typeof json['refine'] === 'string' ? json['refine'].toUpperCase() : undefined;
  const refine = refineValue === 'ADD' || refineValue === 'REPLACE' ? refineValue : parent.refine;
  const contents = parseContents(json, path, transform, ctx);
  const implicit = parseImplicit(json, contents, ctx);
  const viewer =
    json['viewerRequestVolume'] === undefined ? undefined : worldVolume(json['viewerRequestVolume'], transform);
  const tile: Tile3D = {
    id: path,
    parent: parent.tile,
    depth: parent.depth,
    geometricError,
    refine,
    transform,
    volume,
    boundingVolume: json['boundingVolume'] as Json,
    ...(viewer === undefined ? {} : { viewerRequestVolume: viewer }),
    contents: implicit === undefined ? contents : [],
    children: [],
    ...(isRecord(json['metadata']) ? { metadata: json['metadata'] } : {}),
    ...(implicit === undefined ? {} : { implicit, coordinates: { level: 0, x: 0, y: 0, z: 0 } }),
    state: 'unloaded',
    bytes: 0,
  };
  const children = Array.isArray(json['children']) && implicit === undefined ? json['children'] : [];
  const info: ParentInfo = { tile, transform, refine, depth: parent.depth + 1 };
  children.forEach((child, i) => {
    const parsed = parseTile(child, `${path}.children[${i}]`, info, ctx);
    if (parsed !== undefined) tile.children.push(parsed);
  });
  return tile;
}

function problem(ctx: Context, path: string, message: string): undefined {
  ctx.problems.push({ path, message });
  return undefined;
}

/**
 * Parses a tileset. `url` is where it was loaded from (content URIs resolve against it); `parentTile` is the tile
 * whose content this external tileset is, so transforms and refinement carry over.
 */
export function parseTileset(
  input: unknown,
  url: string,
  parentTile?: Tile3D,
): { tileset: Tileset | undefined; problems: TilesetProblem[] } {
  const ctx: Context = { base: url, problems: [], count: 0 };
  if (!isRecord(input))
    return { tileset: undefined, problems: [{ path: '', message: 'a tileset must be a JSON object' }] };
  const asset = input['asset'];
  const version = isRecord(asset) ? asset['version'] : undefined;
  if (version !== '1.0' && version !== '1.1' && version !== '0.0') {
    return {
      tileset: undefined,
      problems: [{ path: 'asset.version', message: `unsupported version ${String(version)}` }],
    };
  }
  const required = Array.isArray(input['extensionsRequired'])
    ? input['extensionsRequired'].filter((e) => typeof e === 'string')
    : [];
  const unsupported = required.filter((e) => !SUPPORTED_EXTENSIONS.includes(e));
  if (unsupported.length > 0) {
    return {
      tileset: undefined,
      problems: [{ path: 'extensionsRequired', message: `unsupported required extensions: ${unsupported.join(', ')}` }],
    };
  }
  const parent: ParentInfo = {
    tile: parentTile,
    transform: parentTile?.transform ?? IDENTITY,
    refine: parentTile?.refine ?? 'REPLACE',
    depth: (parentTile?.depth ?? -1) + 1,
  };
  const root = parseTile(input['root'], 'root', parent, ctx);
  if (root === undefined) return { tileset: undefined, problems: ctx.problems };
  const geometricError = isFiniteNumber(input['geometricError']) ? input['geometricError'] : root.geometricError;
  const tileset: Tileset = {
    version,
    geometricError,
    root,
    ...(isRecord(input['schema']) ? { schema: input['schema'] } : {}),
    ...(typeof input['schemaUri'] === 'string' ? { schemaUri: resolveUri(input['schemaUri'], url) } : {}),
    ...(Array.isArray(input['groups']) ? { groups: input['groups'] } : {}),
    ...(isRecord(input['metadata']) ? { metadata: input['metadata'] } : {}),
    extensionsRequired: required,
  };
  return { tileset, problems: ctx.problems };
}
