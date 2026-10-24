// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { CachedTile, CacheStore } from '../types.js';

/** One check of a contract suite and its outcome. */
export interface ContractResult {
  readonly name: string;
  readonly passed: boolean;
  readonly message?: string;
}

/** A contract check: throws with a message when the implementation breaks the contract. */
type Check<T> = (subject: T) => Promise<void>;

function tileOf(bytes: number[], extra: Partial<CachedTile> = {}): CachedTile {
  return {
    bytes: new Uint8Array(bytes).buffer,
    contentType: 'image/png',
    storedAtMs: 1000,
    freshUntilMs: 2000,
    ...extra,
  };
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const STORE_CHECKS: Record<string, Check<CacheStore>> = {
  'a stored tile reads back with its bytes and metadata': async (store) => {
    await store.put('a/1/2/3', tileOf([1, 2, 3], { etag: '"v1"', lastModified: 'Wed, 21 Oct 2026 07:28:00 GMT' }));
    const tile = await store.get('a/1/2/3');
    expect(tile !== undefined, 'the tile is missing');
    expect([...new Uint8Array(tile?.bytes ?? new ArrayBuffer(0))].join() === '1,2,3', 'the bytes differ');
    expect(tile?.contentType === 'image/png' && tile.freshUntilMs === 2000, 'the metadata differs');
    expect(tile?.etag === '"v1"' && tile.lastModified !== undefined, 'the validators are missing');
  },
  'a missing key reads as undefined': async (store) => {
    expect((await store.get('missing/0/0/0')) === undefined, 'a missing key returned a tile');
  },
  'put replaces a tile and usage counts it once': async (store) => {
    const before = (await store.usage()).bytes;
    await store.put('b/0/0/0', tileOf([1, 2, 3, 4]));
    await store.put('b/0/0/0', tileOf([5, 6]));
    const tile = await store.get('b/0/0/0');
    expect(new Uint8Array(tile?.bytes ?? new ArrayBuffer(0))[0] === 5, 'the tile was not replaced');
    expect((await store.usage()).bytes - before === 2, 'usage does not match the stored bytes');
  },
  'delete removes a tile and its bytes': async (store) => {
    await store.put('c/0/0/0', tileOf([1, 2]));
    const before = (await store.usage()).bytes;
    await store.delete('c/0/0/0');
    expect((await store.get('c/0/0/0')) === undefined, 'the tile is still there');
    expect(before - (await store.usage()).bytes === 2, 'usage did not shrink');
  },
  'deletePrefix removes exactly the keys with the prefix': async (store) => {
    await store.put('p1/0/0/0', tileOf([1]));
    await store.put('p1/1/0/0', tileOf([1]));
    await store.put('p2/0/0/0', tileOf([1]));
    expect((await store.deletePrefix('p1/')) === 2, 'deletePrefix did not report two removals');
    expect((await store.get('p1/1/0/0')) === undefined, 'a prefixed key remains');
    expect((await store.get('p2/0/0/0')) !== undefined, 'another key was removed');
  },
  'a tile larger than the limit is refused with quota, never thrown': async (store) => {
    const quota = (await store.usage()).quotaBytes;
    if (quota === undefined) return;
    const result = await store.put('huge/0/0/0', { ...tileOf([]), bytes: new ArrayBuffer(quota + 1) });
    expect(result === 'quota', `put answered ${result}`);
  },
};

/**
 * The contract every {@link CacheStore} meets (F327): the built-in stores and an application's own run the same
 * checks. `create` returns a fresh, empty store for each check. Framework-free: the caller asserts on the results.
 */
export async function runCacheStoreContract(create: () => CacheStore | Promise<CacheStore>): Promise<ContractResult[]> {
  const results: ContractResult[] = [];
  for (const [name, check] of Object.entries(STORE_CHECKS)) {
    const store = await create();
    try {
      await check(store);
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, message: error instanceof Error ? error.message : String(error) });
    } finally {
      store.close();
    }
  }
  return results;
}
