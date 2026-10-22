/** One check of a conformance suite and its outcome. */
export interface CheckResult {
  /** The adapter or fixture the check ran against. */
  readonly subject?: string;
  /** The area the check covers: 'metadata', 'addressing', 'coverage', 'zoom range', 'error handling', … */
  readonly area: string;
  readonly name: string;
  readonly passed: boolean;
  /** What was observed, for failure messages. */
  readonly detail?: string;
}

/** A check result. */
export function check(area: string, name: string, passed: boolean, detail?: string): CheckResult {
  return detail === undefined ? { area, name, passed } : { area, name, passed, detail };
}

/** The failed checks of a report, one line each, for an assertion message. */
export function failures(results: readonly CheckResult[]): string[] {
  return results
    .filter((r) => !r.passed)
    .map((r) => `${r.subject ?? ''} ${r.area}: ${r.name}${r.detail === undefined ? '' : ` (${r.detail})`}`);
}

/** Faults a conformance check injects into every request of a fixture. */
export type FaultMode = '404' | '500' | 'hang' | 'corrupt';

/** Wraps a fixture fetch so that every request fails in the given way; a hanging request honors its abort signal. */
export function faultyFetch(fixture: typeof fetch, mode: FaultMode): typeof fetch {
  return async (input, init) => {
    if (mode === '404') return new Response(null, { status: 404 });
    if (mode === '500') return new Response(null, { status: 500 });
    if (mode === 'hang') {
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    const real = await fixture(input, init);
    const bytes = new Uint8Array(await real.arrayBuffer());
    let seed = 0x9e3779b9;
    for (let i = 0; i < bytes.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      bytes[i] = seed >>> 24;
    }
    return new Response(bytes, { status: real.status, headers: real.headers });
  };
}

/** True when two byte sequences are equal. */
export function sameBytes(a: ArrayBuffer | Uint8Array, b: ArrayBuffer | Uint8Array): boolean {
  const x = a instanceof Uint8Array ? a : new Uint8Array(a);
  const y = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
