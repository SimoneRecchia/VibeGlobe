import { describe, expect, it } from 'vitest';
import type { TransportResult } from '@vibeglobe/core';
import { fetchTransport, redactUrl } from './fetch-transport.js';

const timeouts = { firstByteMs: 1000, totalMs: 2000 };

/** Runs one request through a transport and resolves with its result. */
function run(transport: ReturnType<typeof fetchTransport>, url: string): Promise<TransportResult> {
  return new Promise((resolve) => transport.start({ url, hostIndex: 0 }, timeouts, resolve));
}

const png = (): Response => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } });

describe('fetch transport security (F251–F253)', () => {
  it('reports a server that answers without CORS headers as a CORS failure, not a network error (F251)', async () => {
    const noCors: typeof fetch = (_input, init) =>
      init?.mode === 'no-cors'
        ? Promise.resolve({ type: 'opaque' } as Response)
        : Promise.reject(new TypeError('Failed to fetch'));
    expect(await run(fetchTransport(noCors), 'https://tiles.example.com/1/0/0.png')).toEqual({
      kind: 'network-error',
      cause: 'cors',
    });
    const down: typeof fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    expect(await run(fetchTransport(down), 'https://tiles.example.com/1/0/0.png')).toEqual({ kind: 'network-error' });
  });

  it("sends a source's credentials only to its hosts and renews them once when refused (F252)", async () => {
    let token = 'old';
    const seen: [string, string | undefined][] = [];
    const server: typeof fetch = (input, init) => {
      const auth = new Headers(init?.headers).get('Authorization') ?? undefined;
      seen.push([String(input), auth]);
      return Promise.resolve(auth === 'Bearer old' ? new Response(null, { status: 401 }) : png());
    };
    const transport = fetchTransport(server, undefined, {
      auth: {
        origins: ['https://secure.example.com'],
        headers: () => ({ Authorization: `Bearer ${token}` }),
        refresh: () => {
          token = 'new';
          return Promise.resolve();
        },
      },
    });
    expect((await run(transport, 'https://secure.example.com/1/0/0.png')).kind).toBe('ok');
    expect((await run(transport, 'https://other.example.com/1/0/0.png')).kind).toBe('ok');
    expect(seen).toEqual([
      ['https://secure.example.com/1/0/0.png', 'Bearer old'],
      ['https://secure.example.com/1/0/0.png', 'Bearer new'],
      ['https://other.example.com/1/0/0.png', undefined],
    ]);
  });

  it('adds a key the provider requires in the URL only when fetching, and redacts keys in URLs for logs (F253)', async () => {
    const fetched: string[] = [];
    const server: typeof fetch = (input) => {
      fetched.push(String(input));
      return Promise.resolve(png());
    };
    const transport = fetchTransport(server, undefined, { secretQuery: () => ({ key: 's3cret' }) });
    await run(transport, 'https://tiles.example.com/1/0/0.png?style=dark');
    expect(fetched).toEqual(['https://tiles.example.com/1/0/0.png?style=dark&key=s3cret']);
    expect(redactUrl('https://a.example/t.png?api_key=abc&z=3&access_token=xyz')).toBe(
      'https://a.example/t.png?api_key=***&z=3&access_token=***',
    );
  });
});
