// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The playground's offline engine (F271, F272, F291, F292; KB-185), loaded only with `?network=online|hybrid|offline`:
 * the fixture imagery is wrapped by `@vibeglobe/offline` in that network mode with every loading feature on (F271), and
 * `?debug=1` adds the rows of where tiles came from, tier by tier (F272).
 */
import type { Globe, ImageryLayerInput } from '@vibeglobe/core';
import { createOffline, type Offline } from '@vibeglobe/offline';

/** The offline engine of `?network=`, with the wrapper of the page's imagery sources. */
export interface PlaygroundOffline {
  readonly offline: Offline;
  /** A layer input with its source, or each source of its chain, wrapped. */
  wrap(input: ImageryLayerInput): ImageryLayerInput;
}

/** Starts the offline engine in `mode`; an unknown mode falls back to hybrid, the default (F271). */
export function playgroundOffline(mode: string | null): PlaygroundOffline {
  const offline = createOffline({ mode: mode === 'online' || mode === 'offline' ? mode : 'hybrid' });
  const wrap = (input: ImageryLayerInput): ImageryLayerInput =>
    'sources' in input
      ? { ...input, sources: input.sources.map((source) => offline.source(source)) }
      : offline.source(input);
  return { offline, wrap };
}

/** The debug overlay's tier rows: GPU, RAM, persistent cache, packages and the network, top tier first (F272). */
export function tierRows(offline: Offline, globe: Globe): [string, string][] {
  const imagery = globe.imageryStats();
  const tiers = offline.stats();
  return [
    ['network-mode', `network ${offline.mode} · ${offline.connectivity}`],
    [
      'tiers',
      `tiers: GPU ${String(imagery?.ready ?? 0)} · RAM hits ${String(imagery?.ramHits ?? 0)} · persistent ` +
        `${String(tiers.persistent + tiers.revalidated)} · package ${String(tiers.package)} · network ${String(tiers.network)}`,
    ],
  ];
}
