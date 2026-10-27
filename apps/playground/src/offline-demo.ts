// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The playground's offline engine (F271, F272, F291, F292; KB-185, KB-196), loaded only with
 * `?network=online|hybrid|offline`: the fixture imagery is wrapped by `@vibeglobe/offline` in that network mode with
 * every loading feature on (F271), its package manager installs the fixture imagery of the whole world as a package
 * (`window.vibeglobeOffline.installWorld()`, kept in IndexedDB across reloads), and `?debug=1` adds the rows of where
 * tiles came from, tier by tier (F272).
 */
import type { Globe, ImageryLayerInput, ImagerySource } from '@vibeglobe/core';
import {
  createOffline,
  createPackageManager,
  type InstalledPackage,
  type Offline,
  type PackageManager,
} from '@vibeglobe/offline';

/** The offline engine of `?network=`, with the wrapper of the page's imagery sources and its packages. */
export interface PlaygroundOffline {
  readonly offline: Offline;
  readonly packages: PackageManager;
  /** A layer input with its source, or each source of its chain, wrapped. */
  wrap(input: ImageryLayerInput): ImageryLayerInput;
  /** The globe whose sources reload when a package or the mode changes what they may load. */
  attach(globe: Globe): void;
  /** Installs the page's imagery of the whole world, levels 0 to `maxLevel`, as the package `playground-world`. */
  installWorld(maxLevel?: number): Promise<InstalledPackage>;
}

declare global {
  interface Window {
    vibeglobeOffline?: PlaygroundOffline;
  }
}

/** Starts the offline engine in `mode`; an unknown mode falls back to hybrid, the default (F271). */
export function playgroundOffline(mode: string | null): PlaygroundOffline {
  const offline = createOffline({ mode: mode === 'online' || mode === 'offline' ? mode : 'hybrid' });
  let globe: Globe | undefined;
  const packages = createPackageManager(offline, {
    onChange: ({ sourceIds }) => {
      for (const id of sourceIds) globe?.reloadSource(id);
    },
  });
  // Back from offline-only mode, the tiles that read as no data load again (KB-158).
  offline.on('mode-change', ({ sourceIds }) => {
    for (const id of sourceIds) globe?.reloadSource(id, { missingOnly: true });
  });
  const sources: ImagerySource[] = [];
  const wrapOne = (source: ImagerySource): ImagerySource => {
    sources.push(source);
    return offline.source(source);
  };
  const demo: PlaygroundOffline = {
    offline,
    packages,
    wrap: (input) =>
      'sources' in input ? { ...input, sources: input.sources.map(wrapOne) } : wrapOne(input as ImagerySource),
    attach: (next) => (globe = next),
    installWorld: (maxLevel = 3) =>
      packages.install({
        id: 'playground-world',
        version: '1',
        area: { westDeg: -180, southDeg: -85, eastDeg: 180, northDeg: 85 },
        minLevel: 0,
        maxLevel,
        sources: sources.map((source) => ({
          source,
          license: 'public-domain',
          attribution: { text: 'Made with Natural Earth' },
        })),
      }),
  };
  window.vibeglobeOffline = demo;
  return demo;
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
