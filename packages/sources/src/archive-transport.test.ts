import type { TileRequest, TransportResult } from '@vibeglobe/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { archiveTransport, fetchRange } from './archive-transport.js';

const TIMEOUTS = { connectMs: 1000, totalMs: 1000 } as unknown as Parameters<
  ReturnType<typeof archiveTransport>['start']
>[1];
const REQUEST = { url: 'pkg#1/0/0', hostIndex: 0 } as unknown as TileRequest;

function run(read: Parameters<typeof archiveTransport>[0]): Promise<TransportResult[]> {
  vi.useFakeTimers();
  const results: TransportResult[] = [];
  archiveTransport(read).start(REQUEST, TIMEOUTS, (result) => results.push(result));
  return vi.advanceTimersByTimeAsync(5000).then(() => {
    vi.useRealTimers();
    return results;
  });
}

describe('archiveTransport', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never throws when a reader fails synchronously, and settles once (PT-02)', async () => {
    const results = await run(() => {
      throw new Error('database disk image is malformed');
    });
    expect(results).toEqual([{ kind: 'ok', bytes: new ArrayBuffer(0), contentType: '' }]);
  });

  it('reports a body cut off mid-read as a network error, not as no data (PT-03)', async () => {
    const cut = {
      status: 206,
      headers: new Headers(),
      arrayBuffer: () => Promise.reject(new TypeError('network connection was lost')),
    } as unknown as Response;
    const fetchImpl = (() => Promise.resolve(cut)) as typeof fetch;
    const results = await run((_url, signal) =>
      fetchRange(fetchImpl, 'https://example.test/a.pmtiles', 0, 16, { signal }).then((bytes) => ({
        bytes,
        contentType: '',
      })),
    );
    expect(results).toEqual([{ kind: 'network-error' }]);
  });
});
