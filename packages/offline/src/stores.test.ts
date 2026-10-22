import { IDBFactory } from 'fake-indexeddb';
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { runCacheStoreContract } from './contract/cache-store-contract.js';
import { runNetworkPolicyContract } from './contract/network-policy-contract.js';
import { defaultNetworkPolicy } from './policy.js';
import { SwitchBoard } from './switches.js';
import { indexedDbStore } from './idb-store.js';
import { memoryStore } from './memory-store.js';
import { workerStore } from './worker-store.js';
import type { CachedTile, NetworkPolicy } from './types.js';

const tile = (size: number): CachedTile => ({
  bytes: new ArrayBuffer(size),
  contentType: 'image/png',
  storedAtMs: 0,
  freshUntilMs: 0,
});

describe('cache stores', () => {
  it('the memory and IndexedDB stores pass the cache-store contract (F327)', async () => {
    for (const create of [
      () => memoryStore({ maxBytes: 4096 }),
      () => indexedDbStore({ indexedDB: new IDBFactory(), maxBytes: 4096 }),
    ]) {
      const results = await runCacheStoreContract(create);
      expect(results.filter((r) => !r.passed)).toEqual([]);
      expect(results.length).toBeGreaterThan(5);
    }
  });

  it('the built-in network policy passes the network-policy contract (F327)', () => {
    const results = runNetworkPolicyContract(() =>
      defaultNetworkPolicy({ mode: () => 'hybrid', switches: new SwitchBoard(), rules: () => undefined }),
    );
    expect(results.filter((r) => !r.passed)).toEqual([]);
    const broken = runNetworkPolicyContract(() => ({
      resolve: () => ({ useNetwork: 1 }) as unknown as ReturnType<NetworkPolicy['resolve']>,
    }));
    expect(broken.filter((r) => !r.passed).length).toBeGreaterThan(0);
  });

  it('evicts least-recently-used tiles and stays within its limit (F274)', async () => {
    const store = indexedDbStore({ indexedDB: new IDBFactory(), maxBytes: 10_000 });
    for (let i = 0; i < 8; i++) await store.put(`s/${i}`, tile(1000));
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Reading tile 0 makes it recent: tiles 1, 2, … go first.
    await store.get('s/0');
    for (let i = 8; i < 14; i++) await store.put(`s/${i}`, tile(1000));
    const usage = await store.usage();
    expect(usage.bytes).toBeLessThanOrEqual(10_000);
    expect(await store.get('s/0')).toBeDefined();
    expect(await store.get('s/1')).toBeUndefined();
    expect(await store.get('s/13')).toBeDefined();
    store.close();
  });

  it('keeps its contents and size across instances, like a page reload (F273)', async () => {
    const factory = new IDBFactory();
    const first = indexedDbStore({ indexedDB: factory });
    await first.put('k/1', tile(300));
    await first.put('k/2', tile(200));
    first.close();
    const second = indexedDbStore({ indexedDB: factory });
    expect((await second.usage()).bytes).toBe(500);
    expect((await second.get('k/2'))?.bytes.byteLength).toBe(200);
    second.close();
  });

  it('answers quota instead of throwing when the browser refuses a write (F274)', async () => {
    const factory = new IDBFactory();
    const store = indexedDbStore({ indexedDB: factory });
    await store.put('q/1', tile(100));
    // A browser reports a full disk when the transaction commits: abort the next write transaction that way.
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
      const tx = original.apply(this, args);
      if (args[1] === 'readwrite' && [...tx.objectStoreNames].includes('tiles')) {
        IDBDatabase.prototype.transaction = original;
        Object.defineProperty(tx, 'error', { value: new DOMException('full', 'QuotaExceededError') });
        queueMicrotask(() => tx.abort());
      }
      return tx;
    };
    try {
      await expect(store.put('q/2', tile(100))).resolves.toBe('quota');
    } finally {
      IDBDatabase.prototype.transaction = original;
    }
    await expect(store.put('q/3', tile(100))).resolves.toBe('stored');
    store.close();
  });

  it('reports a database deleted while open, then works on an empty one (F275)', async () => {
    const factory = new IDBFactory();
    const reasons: string[] = [];
    const store = indexedDbStore({ indexedDB: factory, onLost: (reason) => reasons.push(reason) });
    await store.put('e/1', tile(100));
    await new Promise<void>((resolve) => {
      const request = factory.deleteDatabase('vibeglobe-offline');
      request.onsuccess = () => resolve();
    });
    expect(reasons).toHaveLength(1);
    expect(await store.get('e/1')).toBeUndefined();
    expect((await store.usage()).bytes).toBe(0);
    store.close();
  });
});

describe('workerStore when its worker fails', () => {
  it('rejects calls made after the worker failed to load, instead of leaving them pending (PT-14)', async () => {
    const fake = { postMessage: () => undefined, terminate: () => undefined } as unknown as Worker;
    const store = workerStore({ worker: fake });
    fake.onerror?.(new Event('error') as ErrorEvent);
    const settled = await Promise.race([
      store.get('k').then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 50)),
    ]);
    expect(settled).toBe('rejected');
  });
});

describe('indexedDbStore shared by several tabs', () => {
  it('keeps one database under its limit when two tabs write to it (PT-20)', async () => {
    const factory = new IDBFactory();
    const tabs = [
      indexedDbStore({ indexedDB: factory, maxBytes: 20_000 }),
      indexedDbStore({ indexedDB: factory, maxBytes: 20_000 }),
    ];
    for (let i = 0; i < 30; i++)
      for (const [t, store] of tabs.entries())
        await store.put(`t${t}/${i}`, {
          bytes: new ArrayBuffer(500),
          contentType: 'image/png',
          storedAtMs: 0,
          freshUntilMs: 0,
        });
    const usages = await Promise.all(tabs.map((store) => store.usage()));
    for (const store of tabs) store.close();
    // A fresh instance sums the database itself, like a reload.
    const reloaded = indexedDbStore({ indexedDB: factory, maxBytes: 20_000 });
    const stored = (await reloaded.usage()).bytes;
    reloaded.close();
    expect(stored).toBeLessThanOrEqual(20_000 * 1.05);
    for (const usage of usages) expect(usage.bytes).toBe(stored);
  });
});
