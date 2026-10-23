import { readdirSync, readFileSync } from 'node:fs';
import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { TileContentCache } from './cache.js';
import { batchProperties, parseTileContent, type ParsedContent } from './content.js';
import {
  applySubtree,
  expandImplicitChildren,
  morton,
  needsSubtree,
  parseSubtree,
  subdivideVolume,
  subtreeUri,
} from './implicit.js';
import { resolveEntity } from './metadata.js';
import { parseTileset, type Tile3D } from './tileset.js';
import { requestsToCancel, screenSpaceError, selectTiles, type TraversalCamera } from './traversal.js';
import { distanceToVolume, geodeticToEcef, intersectsFrustum, worldVolume } from './volumes.js';

const FIXTURES = new URL('../__fixtures__/tiles3d/', import.meta.url);
const read = (path: string) => new Uint8Array(readFileSync(new URL(path, FIXTURES)));
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, FIXTURES), 'utf8'));
const BASE = 'https://tiles.example/city/';

// ---------- generated content ----------

const encoder = new TextEncoder();
function padded(text: string): Uint8Array {
  const bytes = encoder.encode(text);
  const out = new Uint8Array(Math.ceil(bytes.length / 8) * 8).fill(0x20);
  out.set(bytes);
  return out;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
function glb(): Uint8Array {
  const json = padded('{"asset":{"version":"2.0"}}');
  const header = new DataView(new ArrayBuffer(20));
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, 20 + json.length, true);
  header.setUint32(12, json.length, true);
  header.setUint32(16, 0x4e4f534a, true);
  return concat(new Uint8Array(header.buffer), json);
}
function binaryTile(
  magic: string,
  headerSize: number,
  tables: [object, Uint8Array, object, Uint8Array],
  body: Uint8Array,
  extra?: number,
): Uint8Array {
  const parts = [padded(JSON.stringify(tables[0])), tables[1], padded(JSON.stringify(tables[2])), tables[3]];
  const total = headerSize + parts.reduce((n, p) => n + p.length, 0) + body.length;
  const header = new DataView(new ArrayBuffer(headerSize));
  [...magic].forEach((c, i) => header.setUint8(i, c.charCodeAt(0)));
  header.setUint32(4, 1, true);
  header.setUint32(8, total, true);
  parts.forEach((p, i) => header.setUint32(12 + 4 * i, p.length, true));
  if (extra !== undefined) header.setUint32(28, extra, true);
  return concat(new Uint8Array(header.buffer), ...parts, body);
}
const heights = new Uint8Array(new Float32Array([12.5, 40]).buffer);
const b3dm = () =>
  binaryTile(
    'b3dm',
    28,
    [
      { BATCH_LENGTH: 2 },
      new Uint8Array(),
      { name: ['Duomo', 'Pirellone'], height: { byteOffset: 0, componentType: 'FLOAT', type: 'SCALAR' } },
      heights,
    ],
    glb(),
  );
const positions = new Uint8Array(new Float32Array([0, 0, 0, 1, 1, 1]).buffer);
const i3dm = () =>
  binaryTile(
    'i3dm',
    32,
    [{ INSTANCES_LENGTH: 2, POSITION: { byteOffset: 0 } }, positions, {}, new Uint8Array()],
    glb(),
    1,
  );
const pnts = () =>
  binaryTile(
    'pnts',
    28,
    [
      { POINTS_LENGTH: 2, POSITION: { byteOffset: 0 }, RGB: { byteOffset: 24 } },
      concat(positions, new Uint8Array(8)),
      {},
      new Uint8Array(),
    ],
    new Uint8Array(),
  );
function cmpt(...tiles: Uint8Array[]): Uint8Array {
  const header = new DataView(new ArrayBuffer(16));
  [...'cmpt'].forEach((c, i) => header.setUint8(i, c.charCodeAt(0)));
  header.setUint32(4, 1, true);
  header.setUint32(8, 16 + tiles.reduce((n, t) => n + t.length, 0), true);
  header.setUint32(12, tiles.length, true);
  return concat(new Uint8Array(header.buffer), ...tiles);
}

// ---------- a generated quadtree tileset in a local frame (meters) ----------

function quadtree(depth: number, refine: 'REPLACE' | 'ADD' = 'REPLACE'): unknown {
  const node = (level: number, cx: number, cy: number, half: number): unknown => ({
    boundingVolume: { box: [cx, cy, 0, half, 0, 0, 0, half, 0, 0, 0, 1] },
    geometricError: level === depth ? 0 : 2 ** (depth - level) * 4,
    content: { uri: `t/${level}_${cx}_${cy}.b3dm` },
    ...(level < depth
      ? {
          children: [-1, 1].flatMap((dx) =>
            [-1, 1].map((dy) => node(level + 1, cx + (dx * half) / 2, cy + (dy * half) / 2, half / 2)),
          ),
        }
      : {}),
  });
  return { asset: { version: '1.0' }, geometricError: 1000, root: { ...(node(0, 0, 0, 512) as object), refine } };
}

const camera = (x: number, y: number, z: number): TraversalCamera => ({
  position: [x, y, z],
  direction: [0, 0, -1],
  viewportHeightPx: 1000,
  fovYRad: Math.PI / 3,
});

function tree(json: unknown): Tile3D {
  const { tileset } = parseTileset(json, `${BASE}tileset.json`);
  if (tileset === undefined) throw new Error('fixture did not parse');
  return tileset.root;
}
const all = (t: Tile3D): Tile3D[] => [t, ...t.children.flatMap(all)];
const ready = (tiles: Iterable<Tile3D>) => {
  for (const t of tiles) t.state = 'ready';
};

describe('3D Tiles conformance (F460)', () => {
  it('parses a 1.0 tileset with transforms, inherited refinement and resolved content', () => {
    const { tileset, problems } = parseTileset(readJson('discrete-lod/tileset.json'), `${BASE}tileset.json`);
    expect(problems).toEqual([]);
    const root = tileset?.root;
    expect(tileset?.geometricError).toBe(500);
    expect(root?.contents[0]?.uri).toBe(`${BASE}dragon_low.b3dm`);
    expect(root?.children[0]?.refine).toBe('REPLACE');
    expect(root?.children[0]?.children[0]?.geometricError).toBe(0);
    const volume = root?.volume;
    expect(volume?.kind).toBe('box');
    expect(volume?.center).toEqual([1215107.7612304366, -4736682.902037748, 4081926.095098698]);
    // The transform scales the box's half-axes (about 100 × the declared size).
    expect(Math.hypot(...((volume as unknown as { halfAxes: number[][] }).halfAxes[0] ?? []))).toBeCloseTo(
      7.0955 * Math.hypot(96.86356343768793, 24.848542777253734),
      6,
    );
  });

  it('parses every bounding volume, multiple contents, external tilesets and metadata', () => {
    const region = [0.1, 0.7, 0.1002, 0.7002, 0, 50];
    const { tileset, problems } = parseTileset(
      {
        asset: { version: '1.1' },
        geometricError: 100,
        schema: { classes: { building: { properties: { height: { type: 'SCALAR', componentType: 'FLOAT32' } } } } },
        groups: [{ class: 'building' }],
        root: {
          boundingVolume: { region },
          geometricError: 50,
          refine: 'add',
          contents: [{ uri: 'a.glb', group: 0 }, { uri: 'b.pnts' }],
          metadata: { class: 'building', properties: { height: 10 } },
          children: [
            { boundingVolume: { sphere: [1, 2, 3, 4] }, geometricError: 1, content: { uri: 'sub/tileset.json' } },
            {
              boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
              geometricError: 1,
              transform: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 10, 0, 0, 1],
            },
          ],
        },
      },
      `${BASE}tileset.json`,
    );
    expect(problems).toEqual([]);
    const root = tileset?.root as Tile3D;
    expect(root.refine).toBe('ADD');
    expect(root.contents.map((c) => [c.uri, c.group])).toEqual([
      [`${BASE}a.glb`, 0],
      [`${BASE}b.pnts`, undefined],
    ]);
    expect(root.metadata).toEqual({ class: 'building', properties: { height: 10 } });
    expect(tileset?.schema).toBeDefined();
    const center = geodeticToEcef(0.1001, 0.7001, 25);
    expect(distanceToVolume(root.volume, center)).toBe(0);
    expect(distanceToVolume(root.volume, geodeticToEcef(0.1001, 0.7001, 1000))).toBeGreaterThan(900);
    expect(root.children[0]?.contents[0]?.external).toBe(true);
    expect(root.children[0]?.refine).toBe('ADD');
    expect(root.children[1]?.volume).toMatchObject({ center: [10, 0, 0] });
    expect(worldVolume({ sphere: [0, 0, 0, 3] }, [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1])).toMatchObject({
      radius: 6,
    });
  });

  it('reports malformed tiles with their path, keeps the rest, and refuses unsupported versions and extensions', () => {
    const { tileset, problems } = parseTileset(
      {
        asset: { version: '1.0' },
        root: {
          boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
          geometricError: 10,
          children: [
            { geometricError: 1 },
            { boundingVolume: { sphere: [0, 0, 0, 1] }, geometricError: -1 },
            { boundingVolume: { sphere: [0, 0, 0, 1] }, geometricError: 1 },
          ],
        },
      },
      'tileset.json',
    );
    expect(problems.map((p) => p.path)).toEqual(['root.children[0].boundingVolume', 'root.children[1].geometricError']);
    expect(tileset?.root.children).toHaveLength(1);
    expect(parseTileset({ asset: { version: '2.0' }, root: {} }, '').problems[0]?.path).toBe('asset.version');
    expect(
      parseTileset({ asset: { version: '1.0' }, extensionsRequired: ['VENDOR_magic'], root: {} }, '').problems[0]
        ?.message,
    ).toContain('VENDOR_magic');
  });

  it('parses b3dm (the public sample and generated), i3dm, pnts, cmpt and glTF content', () => {
    const sample = parseTileContent(read('discrete-lod/dragon_low.b3dm'));
    expect(sample.type).toBe('b3dm');
    expect(String.fromCharCode(...(sample as { glb: Uint8Array }).glb.subarray(0, 4))).toBe('glTF');
    const generated = parseTileContent(b3dm()) as Extract<ParsedContent, { type: 'b3dm' }>;
    expect(generated.batchLength).toBe(2);
    expect(batchProperties(generated.batchTable, 1, generated.batchLength)).toEqual({ name: 'Pirellone', height: 40 });
    expect(batchProperties(generated.batchTable, 2, generated.batchLength)).toEqual({});
    expect(parseTileContent(i3dm())).toMatchObject({ type: 'i3dm', instancesLength: 2 });
    expect(parseTileContent(pnts())).toMatchObject({ type: 'pnts', pointsLength: 2 });
    const composite = parseTileContent(cmpt(b3dm(), cmpt(pnts(), i3dm()))) as Extract<ParsedContent, { type: 'cmpt' }>;
    expect(composite.tiles.map((t) => t.type)).toEqual(['b3dm', 'cmpt']);
    expect(parseTileContent(read('sparse-implicit-quadtree/content/content_5__25_12.glb')).type).toBe('glb');
    expect(parseTileContent(encoder.encode('{"asset":{"version":"1.0"},"root":{}}')).type).toBe('tileset');
    expect(parseTileContent(encoder.encode('{"asset":{"version":"2.0"}}')).type).toBe('gltf');
  });

  it('loads the public sparse implicit quadtree through its subtrees', () => {
    const { tileset } = parseTileset(readJson('sparse-implicit-quadtree/tileset.json'), `${BASE}tileset.json`);
    const root = tileset?.root as Tile3D;
    expect(needsSubtree(root)).toBe(true);
    const pending = [root];
    let loaded = 0;
    while (pending.length > 0) {
      const tile = pending.pop() as Tile3D;
      if (needsSubtree(tile)) {
        const uri = subtreeUri(tile) ?? '';
        const subtree = parseSubtree(
          read(`sparse-implicit-quadtree/${uri.slice(BASE.length)}`),
          root.implicit as never,
        );
        if ('error' in subtree) throw new Error(subtree.error);
        applySubtree(tile, subtree);
        loaded++;
      }
      expandImplicitChildren(tile);
      pending.push(...tile.children);
    }
    expect(loaded).toBe(9);
    const leaves = all(root).filter((t) => t.coordinates?.level === 5 && t.contents.length > 0);
    expect(leaves).toHaveLength(32);
    const names = leaves.map((t) => t.contents[0]?.uri.slice(BASE.length));
    for (const file of readdirSync(new URL('sparse-implicit-quadtree/content/', FIXTURES)))
      expect(names).toContain(`content/${file}`);
    const leaf = leaves[0] as Tile3D;
    expect(leaf.geometricError).toBe(1);
    expect(leaf.refine).toBe('ADD');
    expect(morton(1, 0, 0, false)).toBe(1);
    expect(morton(0, 1, 0, false)).toBe(2);
    expect(morton(3, 3, 0, false)).toBe(15);
    expect(subdivideVolume({ region: [0, 0, 4, 4, 0, 8] }, { level: 1, x: 1, y: 0, z: 1 }, true)).toEqual({
      region: [2, 0, 4, 2, 4, 8],
    });
  });

  const json = fc.jsonValue({ maxDepth: 3 });
  test.prop([fc.array(fc.tuple(fc.nat(300), fc.string({ maxLength: 16 }), json), { minLength: 1, maxLength: 8 })], {
    numRuns: 150,
  })('tileset JSON fuzzing never throws and keeps a usable tree', (mutations) => {
    const input = quadtree(2) as Record<string, unknown>;
    for (const [where, key, value] of mutations) {
      const targets = objects(input);
      const target = targets[where % targets.length];
      if (target !== undefined) target[key === '' ? 'geometricError' : key] = value;
    }
    const { tileset } = parseTileset(input, 'tileset.json');
    if (tileset !== undefined)
      expect(() => selectTiles(tileset.root, camera(0, 0, 300), { maximumScreenSpaceError: 16 })).not.toThrow();
  });

  test.prop(
    [
      fc.constantFrom(b3dm(), i3dm(), pnts(), cmpt(b3dm(), pnts())),
      fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 12 }),
      fc.nat(),
    ],
    { numRuns: 300 },
  )('content fuzzing (bit flips, truncation) yields a typed result, never an exception', (bytes, flips, cut) => {
    const copy = bytes.slice(0, bytes.length - (cut % (bytes.length + 1)));
    for (const [at, value] of flips) if (copy.length > 0) copy[at % copy.length] = value;
    const result = parseTileContent(copy);
    expect(typeof result.type).toBe('string');
    const tiling = {
      scheme: 'QUADTREE' as const,
      subtreeLevels: 3,
      availableLevels: 6,
      subtrees: '',
      contents: [],
      rootVolume: {},
      rootGeometricError: 1,
    };
    expect(() => parseSubtree(copy, tiling)).not.toThrow();
  });
});

function objects(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (value !== null && typeof value === 'object') {
    if (!Array.isArray(value)) out.push(value as Record<string, unknown>);
    for (const child of Object.values(value)) objects(child, out);
  }
  return out;
}

describe('traversal by screen-space error (F461)', () => {
  const options = { maximumScreenSpaceError: 16 };

  it('computes the screen-space error from the geometric error', () => {
    expect(screenSpaceError(4, 100, camera(0, 0, 0))).toBeCloseTo((4 * 1000) / (2 * 100 * Math.tan(Math.PI / 6)), 9);
    expect(screenSpaceError(4, 0, camera(0, 0, 0))).toBe(Infinity);
  });

  it('draws the root from far away and refines up close', () => {
    const root = tree(quadtree(3));
    ready(all(root));
    const far = selectTiles(root, camera(0, 0, 1e6), options);
    expect(far.render).toEqual([root]);
    const near = selectTiles(root, camera(10, 10, 2), options);
    expect(near.render.some((t) => t.depth === 3)).toBe(true);
    expect(near.render).not.toContain(root);
    expect(near.screenSpaceError.get(root)).toBeGreaterThan(16);
  });

  it('keeps a REPLACE parent until every child is ready, also when a child fails', () => {
    const root = tree(quadtree(1));
    root.state = 'ready';
    const close = camera(0, 0, 5);
    let result = selectTiles(root, close, options);
    expect(result.render).toEqual([root]);
    expect(result.requests.map((r) => r.tile)).toEqual(expect.arrayContaining(root.children));
    ready(root.children.slice(0, 3));
    (root.children[3] as Tile3D).state = 'failed';
    result = selectTiles(root, close, options);
    expect(result.render).toEqual([root]);
    (root.children[3] as Tile3D).state = 'ready';
    expect(selectTiles(root, close, options).render).toEqual(root.children);
  });

  it('draws parent and children with ADD refinement', () => {
    const root = tree(quadtree(1, 'ADD'));
    ready(all(root));
    expect(selectTiles(root, camera(0, 0, 5), options).render).toEqual([root, ...root.children]);
  });

  it('never leaves a hole on a slow, random network once the root is loaded', () => {
    const root = tree(quadtree(4));
    const random = mulberry(7);
    const loading = new Set<Tile3D>();
    for (let frame = 0; frame < 400; frame++) {
      const t = frame / 400;
      const cam = camera(-400 + 800 * t, 300 * Math.sin(t * 6), 600 - 590 * Math.min(1, 2 * t));
      const rootReady = root.state === 'ready';
      const result = selectTiles(root, cam, options);
      for (const r of result.requests) {
        r.tile.state = 'loading';
        loading.add(r.tile);
      }
      for (const tile of loading) {
        if (random() >= 0.05) continue;
        loading.delete(tile);
        tile.state = random() < 0.03 && tile !== root ? 'failed' : 'ready';
      }
      if (!rootReady) continue;
      for (let i = 0; i < 64; i++) {
        const p = [-512 + 1024 * random(), -512 + 1024 * random(), 0];
        expect(result.render.some((tile) => distanceToVolume(tile.volume, p) === 0)).toBe(true);
      }
    }
  });
});

describe('request priorities, cancellation and memory budget (F462)', () => {
  it('requests screen-center tiles before peripheral ones', () => {
    const root = tree(quadtree(2));
    root.state = 'ready';
    for (const c of root.children) c.state = 'ready';
    const result = selectTiles(
      root,
      { ...camera(-300, -300, 60), direction: [0, 0, -1] },
      { maximumScreenSpaceError: 16 },
    );
    const first = result.requests[0]?.tile as Tile3D;
    const last = result.requests.at(-1)?.tile as Tile3D;
    const d = (t: Tile3D) => Math.hypot((t.volume.center[0] ?? 0) + 300, (t.volume.center[1] ?? 0) + 300);
    expect(d(first)).toBeLessThan(d(last));
  });

  it('cancels requests the view no longer needs after the camera moves', () => {
    const root = tree(quadtree(3));
    ready([root, ...root.children]);
    const before = selectTiles(root, camera(-400, -400, 30), { maximumScreenSpaceError: 16 });
    const inFlight = before.requests.map((r) => r.tile);
    const after = selectTiles(
      root,
      { ...camera(400, 400, 30), planes: [[1, 0, 0, 0]] },
      { maximumScreenSpaceError: 16 },
    );
    const cancelled = requestsToCancel(inFlight, after);
    expect(cancelled.length).toBeGreaterThan(0);
    const culled = inFlight.filter((t) => (t.volume.center[0] ?? 0) + 512 / 2 ** t.depth < 0);
    expect(culled.length).toBeGreaterThan(0);
    expect(cancelled).toEqual(expect.arrayContaining(culled));
    const wanted = new Set(after.requests.map((r) => r.tile));
    expect(cancelled.some((t) => wanted.has(t) || after.used.has(t))).toBe(false);
  });

  it('stays within budget through randomized navigation, overflowing only for tiles in view, and reloads evicted tiles', () => {
    const root = tree(quadtree(4));
    const cache = new TileContentCache(400_000);
    const random = mulberry(11);
    const evicted = new Set<Tile3D>();
    for (let frame = 0; frame < 600; frame++) {
      const cam = camera(-500 + 1000 * random(), -500 + 1000 * random(), 5 + 400 * random());
      const result = selectTiles(root, cam, { maximumScreenSpaceError: 16 });
      for (const { tile } of result.requests) {
        if (evicted.has(tile)) evicted.delete(tile);
        tile.state = 'ready';
        tile.bytes = 10_000 + tile.depth * 1000;
        cache.add(tile);
      }
      cache.touch(result.used);
      for (const t of cache.trim(result.used)) evicted.add(t);
      const usedBytes = [...result.used].reduce((n, t) => n + t.bytes, 0);
      expect(cache.bytes).toBeLessThanOrEqual(Math.max(cache.budgetBytes, usedBytes));
    }
    expect(evicted.size).toBeGreaterThan(0);
    const [again] = evicted;
    expect(again?.state).toBe('unloaded');
  });
});

describe('volumes', () => {
  it('culls volumes outside the frustum', () => {
    const box = worldVolume({ box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] });
    expect(box && intersectsFrustum(box, [[1, 0, 0, 0.5]])).toBe(true);
    expect(box && intersectsFrustum(box, [[1, 0, 0, -2]])).toBe(false);
  });
});

function mulberry(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('3D Tiles 1.1 metadata (F460)', () => {
  const schema = {
    classes: {
      building: {
        properties: {
          height: { type: 'SCALAR', componentType: 'UINT16', normalized: true, scale: 100, offset: 5 },
          name: { type: 'STRING' },
          kind: { type: 'ENUM', enumType: 'kind' },
          tall: { type: 'BOOLEAN' },
          floors: { type: 'SCALAR', componentType: 'UINT8', array: true },
          pos: { type: 'VEC2', componentType: 'FLOAT32', noData: [0, 0], default: [9, 9] },
          note: { type: 'STRING', default: 'none' },
        },
      },
    },
    enums: {
      kind: {
        values: [
          { name: 'church', value: 1 },
          { name: 'tower', value: 2 },
        ],
      },
    },
  } as const;

  it('resolves JSON entities with defaults, normalization, offset, scale and enums', () => {
    expect(
      resolveEntity({ class: 'building', properties: { height: 65535, kind: 2, tall: true, pos: [0, 0] } }, schema),
    ).toEqual({
      height: 105,
      kind: 'tower',
      tall: true,
      pos: [9, 9],
      note: 'none',
    });
    expect(resolveEntity({ class: 'unknown', properties: { a: 1 } }, schema)).toEqual({ a: 1 });
  });

  it('reads tile metadata from a subtree property table, rows in availability order', () => {
    const u16 = new Uint8Array(new Uint16Array([0, 65535]).buffer);
    const strings = encoder.encode('DuomoTorre');
    const stringOffsets = new Uint8Array(new Uint32Array([0, 5, 10]).buffer);
    const kinds = new Uint8Array(new Uint16Array([1, 2]).buffer);
    const tall = new Uint8Array([0b10]);
    const floors = new Uint8Array([3, 1, 2, 3]);
    const floorOffsets = new Uint8Array(new Uint32Array([0, 1, 4]).buffer);
    // Tile availability of a 2-level quadtree subtree: the root and child 3 (bits 0 and 4).
    const availability = new Uint8Array([0b10001]);
    const parts = [availability, u16, strings, stringOffsets, kinds, tall, floors, floorOffsets];
    let offset = 0;
    const bufferViews = parts.map((p) => {
      const view = { buffer: 0, byteOffset: offset, byteLength: p.length };
      offset += Math.ceil(p.length / 8) * 8;
      return view;
    });
    const binary = new Uint8Array(offset);
    parts.forEach((p, i) => binary.set(p, bufferViews[i]?.byteOffset ?? 0));
    const json = {
      buffers: [{ byteLength: binary.length }],
      bufferViews,
      tileAvailability: { bitstream: 0 },
      contentAvailability: [{ constant: 0 }],
      childSubtreeAvailability: { constant: 0 },
      propertyTables: [
        {
          class: 'building',
          count: 2,
          properties: {
            height: { values: 1 },
            name: { values: 2, stringOffsets: 3 },
            kind: { values: 4 },
            tall: { values: 5 },
            floors: { values: 6, arrayOffsets: 7 },
          },
        },
      ],
      tileMetadata: 0,
    };
    const jsonBytes = padded(JSON.stringify(json));
    const header = new DataView(new ArrayBuffer(24));
    [...'subt'].forEach((c, i) => header.setUint8(i, c.charCodeAt(0)));
    header.setUint32(4, 1, true);
    header.setBigUint64(8, BigInt(jsonBytes.length), true);
    header.setBigUint64(16, BigInt(binary.length), true);
    const file = concat(new Uint8Array(header.buffer), jsonBytes, binary);
    const { tileset } = parseTileset(
      {
        asset: { version: '1.1' },
        schema,
        root: {
          boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
          geometricError: 8,
          content: { uri: 'c/{level}/{x}/{y}.glb' },
          implicitTiling: {
            subdivisionScheme: 'QUADTREE',
            subtreeLevels: 2,
            availableLevels: 2,
            subtrees: { uri: 's/{level}/{x}/{y}.subtree' },
          },
        },
      },
      `${BASE}tileset.json`,
    );
    const root = tileset?.root as Tile3D;
    const subtree = parseSubtree(file, root.implicit as never);
    if ('error' in subtree) throw new Error(subtree.error);
    applySubtree(root, subtree);
    expect(root.metadata).toEqual({
      height: 5,
      name: 'Duomo',
      kind: 'church',
      tall: false,
      floors: [3],
      pos: [9, 9],
      note: 'none',
    });
    expect(root.children.map((c) => c.coordinates)).toEqual([{ level: 1, x: 1, y: 1, z: 0 }]);
    expect(root.children[0]?.metadata).toEqual({
      height: 105,
      name: 'Torre',
      kind: 'tower',
      tall: true,
      floors: [1, 2, 3],
      pos: [9, 9],
      note: 'none',
    });
    expect(root.contents).toEqual([]);
  });
});
