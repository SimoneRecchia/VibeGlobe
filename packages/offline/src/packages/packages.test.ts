import type { TileCoord, TransportResult } from '@vibeglobe/core';
import { pmtilesImagery, xyzImagery } from '@vibeglobe/sources';
import { mbtilesImagery } from '@vibeglobe/sources/mbtiles';
import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { writeMbtiles } from '../__fixtures__/mbtiles-writer.js';
import { writePmtiles } from '../__fixtures__/pmtiles-writer.js';
import { memoryStore } from '../memory-store.js';
import { createOffline, type Offline } from '../offline-engine.js';
import { createManifest } from './create-manifest.js';
import type { PackageManifest } from './manifest.js';
import type { PackageRequest } from './builder.js';
import { createPackageManager, type PackageManager } from './package-manager.js';
import type { ArchiveAdapters } from './reader.js';

const BOUNDS = { westDeg: 12, southDeg: 41.5, eastDeg: 13, northDeg: 42.2 };
const SOURCE = { sourceId: 'osm', file: 'rome.pmtiles', minLevel: 0, maxLevel: 2, license: 'ODbL-1.0' };

/** A fixture archive whose tiles carry their own coordinates and the package version as bytes. */
function archive(version: string, levels = [0, 1, 2]): Uint8Array {
  const tiles = levels.flatMap((z) =>
    Array.from({ length: 4 ** z }, (_, i) => ({
      z,
      x: i % 2 ** z,
      y: Math.floor(i / 2 ** z),
      bytes: new TextEncoder().encode(`${version}:${z}/${i % 2 ** z}/${Math.floor(i / 2 ** z)}`),
    })),
  );
  return writePmtiles(tiles, { name: 'rome', version });
}

async function manifestOf(version: string, data: Uint8Array, chunkBytes = 64): Promise<PackageManifest> {
  return createManifest({
    id: 'rome',
    version,
    name: 'Rome',
    area: BOUNDS,
    sources: [{ ...SOURCE, attribution: { text: '© OpenStreetMap contributors' } }],
    files: [{ path: 'rome.pmtiles', format: 'pmtiles', data: new Blob([data as Uint8Array<ArrayBuffer>]) }],
    chunkBytes,
  });
}

/** A fake LAN server: a manifest and its file per path. */
function server(files: Record<string, Uint8Array | string>) {
  const requests: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    const body = files[url.pathname];
    if (body === undefined) return new Response('missing', { status: 404 });
    if (typeof body === 'string') return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    const range = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('Range') ?? '');
    if (!range) return new Response(body as Uint8Array<ArrayBuffer>);
    return new Response(body.slice(Number(range[1]), Number(range[2]) + 1), { status: 206 });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const adapters: ArchiveAdapters = { pmtiles: pmtilesImagery, mbtiles: mbtilesImagery };
const engines: { offline: Offline; manager: PackageManager }[] = [];

function setup(factory = new IDBFactory(), fetchImpl?: typeof fetch, mode: 'offline' | 'hybrid' = 'offline') {
  const offline = createOffline({ store: memoryStore(), mode, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  const errors: string[] = [];
  const memory = new Map<string, string>();
  const manager = createPackageManager(offline, {
    adapters,
    indexedDB: factory,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    localStorage: { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => void memory.set(k, v) },
    onIntegrityError: (e) => errors.push(e.message),
  });
  engines.push({ offline, manager });
  const source = offline.source(xyzImagery({ id: 'osm', url: 'https://tiles.test/{z}/{x}/{y}.png', maxLevel: 4 }));
  return { offline, manager, source, errors, memory };
}

afterEach(() => {
  for (const { offline, manager } of engines.splice(0)) {
    manager.destroy();
    offline.destroy();
  }
});

function load(source: ReturnType<typeof setup>['source'], coord: TileCoord): Promise<string> {
  const request = source.request(coord, { url: '', hostIndex: 0 });
  if (request === 'noData') return Promise.resolve('noData');
  return new Promise<TransportResult>((resolve) =>
    source.transport.start(request, { firstByteMs: 1000, totalMs: 1000 }, resolve),
  ).then((r) =>
    r.kind === 'ok' ? new TextDecoder().decode(r.bytes) : r.kind === 'status' ? String(r.status) : r.kind,
  );
}

const tile = (level: number, x: number, y: number): TileCoord => ({ root: 0, level, x, y });

describe('offline packages', () => {
  it('installs from a URL and from local files, lists them with their metadata, and serves their tiles (F311)', async () => {
    const data = archive('1');
    const manifest = await manifestOf('1', data);
    const net = server({ '/pkg/rome.json': JSON.stringify(manifest), '/pkg/rome.pmtiles': data });
    const factory = new IDBFactory();
    const { manager, source } = setup(factory, net.fetchImpl);
    const progress: number[] = [];
    await manager.install('https://lan.test/pkg/rome.json', { onProgress: (p) => progress.push(p.loadedBytes) });
    expect(progress.at(-1)).toBe(data.length);
    const local = { ...manifest, id: 'rome-local' };
    await manager.install({
      manifest: new Blob([JSON.stringify(local)]),
      files: { 'rome.pmtiles': new Blob([data as Uint8Array<ArrayBuffer>]) },
    });
    const listed = await manager.list();
    expect(listed.map((p) => p.id).sort()).toEqual(['rome', 'rome-local']);
    expect(listed[0]).toMatchObject({
      version: '1',
      name: 'Rome',
      area: BOUNDS,
      minLevel: 0,
      maxLevel: 2,
      licenses: ['ODbL-1.0'],
    });
    expect(listed[0]?.bytes).toBe(data.length);
    expect(await load(source, tile(2, 1, 3))).toBe('1:2/1/3');
    // Beyond the package: no data in offline-only mode, and no request ever.
    expect(await load(source, tile(3, 0, 0))).toBe('404');
    expect(net.requests.filter((p) => !p.startsWith('/pkg/'))).toEqual([]);
    // A new page sees the same list.
    const again = setup(factory, net.fetchImpl);
    expect((await again.manager.list()).map((p) => p.id).sort()).toEqual(['rome', 'rome-local']);
  });

  it('installs and reads an MBTiles package (F311)', async () => {
    const tiles = [0, 1].flatMap((z) =>
      Array.from({ length: 4 ** z }, (_, i) => ({ z, x: i % 2 ** z, y: Math.floor(i / 2 ** z) })),
    );
    const data = await writeMbtiles(
      tiles.map((t) => ({ ...t, bytes: new TextEncoder().encode(`mb:${t.z}/${t.x}/${t.y}`) })),
      { name: 'mb', format: 'png', minzoom: '0', maxzoom: '1' },
    );
    const manifest = await createManifest({
      id: 'mb',
      version: '1',
      area: BOUNDS,
      sources: [{ ...SOURCE, file: 'mb.mbtiles', maxLevel: 1, attribution: { text: 'MB' } }],
      files: [{ path: 'mb.mbtiles', format: 'mbtiles', data: new Blob([data as Uint8Array<ArrayBuffer>]) }],
    });
    const { manager, source } = setup();
    await manager.install({ manifest, files: { 'mb.mbtiles': new Blob([data as Uint8Array<ArrayBuffer>]) } });
    expect(await load(source, tile(1, 1, 0))).toBe('mb:1/1/0');
  });

  it('detects corruption in the header, the directory and the tile data, on install and on read (F309)', async () => {
    const data = archive('1');
    const manifest = await manifestOf('1', data);
    for (const [at, part] of [
      [3, 'header'],
      [130, 'root directory'],
      [data.length - 2, 'tile data'],
    ] as const) {
      const corrupted = data.slice();
      corrupted[at] = (corrupted[at] ?? 0) ^ 0xff;
      const { manager } = setup(new IDBFactory());
      const files = { 'rome.pmtiles': new Blob([corrupted]) };
      const error = await manager.install({ manifest, files }).catch((e: unknown) => e as Error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(part);
      expect(await manager.list()).toEqual([]);
      // Read from a LAN server without installing: the hit chunk reads as missing, the rest is served.
      const net = server({ '/lan/rome.json': JSON.stringify(manifest), '/lan/rome.pmtiles': corrupted });
      const lan = setup(new IDBFactory(), net.fetchImpl);
      await lan.manager.addServedPackage('https://lan.test/lan/rome.json');
      const results = await Promise.all([tile(0, 0, 0), tile(1, 0, 0), tile(2, 3, 3)].map((c) => load(lan.source, c)));
      expect(lan.errors.join(' ')).toMatch(/SHA-256|cannot be read/);
      expect(results.every((r) => r === '404' || r.startsWith('1:'))).toBe(true);
      if (part === 'tile data') expect(results.filter((r) => r.startsWith('1:')).length).toBeGreaterThan(0);
    }
  });

  it('a new version replaces the old one; removing a package frees its storage (F279, F312)', async () => {
    const v1 = archive('1');
    const v2 = archive('2');
    const files: Record<string, Uint8Array | string> = {
      '/pkg/rome.json': JSON.stringify(await manifestOf('1', v1)),
      '/pkg/rome.pmtiles': v1,
    };
    const net = server(files);
    const { manager, source } = setup(new IDBFactory(), net.fetchImpl);
    await manager.install('https://lan.test/pkg/rome.json');
    expect(await load(source, tile(1, 1, 1))).toBe('1:1/1/1');
    files['/pkg/rome.json'] = JSON.stringify(await manifestOf('2', v2));
    files['/pkg/rome.pmtiles'] = v2;
    await manager.update('rome');
    expect((await manager.list()).map((p) => p.version)).toEqual(['2']);
    expect(await load(source, tile(1, 1, 1))).toBe('2:1/1/1');
    expect(await load(source, tile(2, 0, 0))).toBe('2:2/0/0');
    expect((await manager.storageUsage()).packages).toEqual([{ id: 'rome', bytes: v2.length }]);
    await manager.remove('rome');
    expect(await manager.list()).toEqual([]);
    expect((await manager.storageUsage()).totalBytes).toBe(0);
    expect(await load(source, tile(1, 1, 1))).toBe('404');
  });

  it('resumes an interrupted install without downloading stored chunks again (F308)', async () => {
    const data = archive('1');
    const manifest = await manifestOf('1', data);
    const net = server({ '/pkg/rome.json': JSON.stringify(manifest), '/pkg/rome.pmtiles': data });
    const factory = new IDBFactory();
    const first = setup(factory, net.fetchImpl);
    const controller = new AbortController();
    await first.manager
      .install('https://lan.test/pkg/rome.json', {
        signal: controller.signal,
        onProgress: (p) => p.loadedBytes > data.length / 2 && controller.abort(),
      })
      .catch(() => undefined);
    const before = net.requests.filter((p) => p.endsWith('.pmtiles')).length;
    // A new page (the old one was closed) installs the same version again.
    const second = setup(factory, net.fetchImpl);
    let resumed = 0;
    await second.manager.install('https://lan.test/pkg/rome.json', { onProgress: (p) => (resumed = p.resumedBytes) });
    const after = net.requests.filter((p) => p.endsWith('.pmtiles')).length - before;
    const chunks = Math.ceil(data.length / 64);
    expect(resumed).toBeGreaterThan(0);
    expect(before + after).toBe(chunks);
    expect(await load(second.source, tile(2, 2, 2))).toBe('1:2/2/2');
  });

  it('builds a package in the browser, honouring the packaging switch and the provider rules (F289, F319)', async () => {
    const net = server({});
    const tileFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://lan.test')) return net.fetchImpl(input);
      return new Response(new TextEncoder().encode(`net:${new URL(url).pathname}`), {
        headers: { 'Content-Type': 'image/png' },
      });
    }) as typeof fetch;
    const { offline, manager } = setup(new IDBFactory(), tileFetch);
    const a = xyzImagery({ id: 'a', url: 'https://a.test/{z}/{x}/{y}.png' });
    const b = xyzImagery({ id: 'b', url: 'https://b.test/{z}/{x}/{y}.png' });
    const google = { id: 'google', forbids: new Set(['offlinePackaging'] as const), respectCacheHeaders: true };
    const request = (r: PackageRequest): PackageRequest => r;
    const base = {
      id: 'area',
      version: '1',
      area: {
        polygonDeg: [
          [12, 41],
          [13, 41],
          [12.5, 42],
        ] as [number, number][],
      },
      minLevel: 0,
      maxLevel: 6,
    };
    const credit = { license: 'CC-BY-4.0', attribution: { text: 'Fixture' } };
    const forbidden = manager.install(
      request({
        ...base,
        sources: [
          { source: a, ...credit },
          { source: b, rules: google, ...credit },
        ],
      }),
    );
    await expect(forbidden).rejects.toThrow(/'b'.*'google' forbids offline packaging/);
    offline.setSwitches({ offlinePackaging: false }, { sourceId: 'b' });
    const built = await manager.install(
      request({
        ...base,
        sources: [
          { source: a, ...credit },
          { source: b, ...credit },
        ],
      }),
    );
    expect(built.report?.included).toEqual(['a']);
    expect(built.report?.excluded).toEqual([
      { sourceId: 'b', reason: 'offline packaging is switched off for this source' },
    ]);
    expect((await manager.estimate(request({ ...base, sources: [{ source: a, ...credit }] }))).tiles).toBe(
      built.report?.tiles,
    );
    const reader = offline.source(xyzImagery({ id: 'a', url: 'https://a.test/{z}/{x}/{y}.png' }));
    expect(await load(reader, tile(6, 34, 23))).toBe('net:/6/34/23.png');
    offline.setSwitches({ offlinePackaging: false });
    await expect(
      manager.install(request({ ...base, id: 'other', sources: [{ source: a, ...credit }] })),
    ).rejects.toThrow(/switched off globally/);
  });

  it('reports packages the browser evicted between sessions (F275)', async () => {
    const data = archive('1');
    const manifest = await manifestOf('1', data);
    const net = server({ '/pkg/rome.json': JSON.stringify(manifest), '/pkg/rome.pmtiles': data });
    const first = setup(new IDBFactory(), net.fetchImpl);
    await first.manager.install('https://lan.test/pkg/rome.json');
    // The next session finds an empty database (the browser evicted it) but the list of what was stored.
    const offline = createOffline({ store: memoryStore(), mode: 'offline' });
    const lost: string[][] = [];
    offline.on('storage-lost', (event) => lost.push([...event.packages]));
    const manager = createPackageManager(offline, {
      adapters,
      indexedDB: new IDBFactory(),
      localStorage: { getItem: (k) => first.memory.get(k) ?? null, setItem: () => undefined },
    });
    engines.push({ offline, manager });
    await manager.ready;
    await Promise.resolve();
    expect(lost).toEqual([['rome']]);
  });
});
