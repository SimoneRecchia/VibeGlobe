// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Network timings of the transport's own responses, from the Resource Timing API (F300): when the response's headers
 * arrived and its last byte, as the browser's network stack saw them. The main thread may notice a response's end a
 * frame later, which on a fast link would make a few-millisecond transfer look many times longer. Entries reach a
 * `PerformanceObserver` one task after the body (they are observed, not read from the timeline, whose buffer a page
 * may have filled long before).
 */

/** A response's network timings: the wait for its headers, its transfer, and how long ago its last byte arrived. */
export interface NetworkTiming {
  readonly waitMs: number;
  readonly transferMs: number;
  readonly endAgoMs: number;
  /** Served from the HTTP cache: says nothing about the link. */
  readonly cached: boolean;
}

const expected = new Set<string>();
const observed = new Map<string, PerformanceResourceTiming>();
let observer: PerformanceObserver | null | undefined;

const absolute = (url: string): string => {
  try {
    return new URL(url, globalThis.location?.href).href;
  } catch {
    return url;
  }
};

/** Starts observing (once per page); false where the API is missing. */
function observing(): boolean {
  if (observer === undefined) {
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          if (expected.has(entry.name)) observed.set(entry.name, entry as PerformanceResourceTiming);
      });
      observer.observe({ type: 'resource' });
    } catch {
      observer = null;
    }
  }
  return observer !== null;
}

/** A request to `url` starts: its timing entry is kept when it arrives. False when no timings can be had. */
export function expectTiming(url: string): boolean {
  // Browsers only (a page or a worker): Node reports no timings for the fetches of tests and tools.
  if (globalThis.location === undefined || typeof PerformanceObserver === 'undefined' || !observing()) return false;
  expected.add(absolute(url));
  return true;
}

/**
 * The timings of the response to `url`, once its entry arrived (a task after its body); undefined without one, or
 * for a cross-origin server that does not allow timings (`Timing-Allow-Origin`). Forgets the request either way.
 */
export function takeTiming(url: string): NetworkTiming | undefined {
  const name = absolute(url);
  const entry = observed.get(name);
  expected.delete(name);
  observed.delete(name);
  if (!entry || entry.responseStart <= 0 || entry.responseEnd < entry.responseStart) return undefined;
  return {
    waitMs: entry.responseStart - entry.startTime,
    transferMs: entry.responseEnd - entry.responseStart,
    endAgoMs: Math.max(0, performance.now() - entry.responseEnd),
    cached: entry.transferSize === 0 && entry.encodedBodySize > 0,
  };
}
