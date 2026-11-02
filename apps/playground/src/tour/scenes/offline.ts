// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The Offline scene: the fixture server's imagery (`earth-package`, a toned copy of the Natural Earth image) wrapped
 * by the offline engine, its network mode switched at runtime, the area in view installed as a package in this
 * browser's IndexedDB, and the tier each tile came from.
 */
import type { GeoBounds } from '@vibeglobe/core';
import { createOffline, createPackageManager, type NetworkMode, type PackageManager } from '@vibeglobe/offline';
import { xyzImagery } from '@vibeglobe/sources';
import type { Readout } from '../panel.js';
import type { SceneContext, SceneModule } from '../types.js';

const SOURCE_ID = 'offline-earth';
const MB = 1_048_576;

/** The area in view, or Italy when the view's corners are off the globe. */
function viewBounds(context: SceneContext): GeoBounds {
  const box = context.container.getBoundingClientRect();
  const corners = [
    [0, 0],
    [box.width, box.height],
  ].map(([xPx = 0, yPx = 0]) => context.globe.screenToGeo({ xPx, yPx }));
  const [nw, se] = corners;
  if (!nw || !se) return { westDeg: 6.6, southDeg: 36.6, eastDeg: 18.5, northDeg: 47.1 };
  return { westDeg: nw.longitudeDeg, southDeg: se.latitudeDeg, eastDeg: se.longitudeDeg, northDeg: nw.latitudeDeg };
}

/** Lists the installed packages. */
async function listPackages(packages: PackageManager, readout: Readout): Promise<void> {
  const installed = await packages.list();
  readout(
    installed.length === 0
      ? [['Packages', 'none installed']]
      : installed.map(
          (p) =>
            [p.id, `levels ${String(p.minLevel)}–${String(p.maxLevel)} · ${(p.bytes / MB).toFixed(1)} MB`] as const,
        ),
  );
}

/** The install, removal and listing of the scene's packages. */
function packageControls(context: SceneContext, packages: PackageManager, source: ReturnType<typeof xyzImagery>): void {
  const group = context.panel.group('Packages');
  const progress = group.progress();
  const list = group.readout();
  let next = 0;
  const install = async (): Promise<void> => {
    const maxLevel = Math.min(12, Math.max(4, Math.round(context.globe.camera.zoom) + 1));
    const request = {
      id: `view-${String(++next)}`,
      version: '1',
      area: viewBounds(context),
      minLevel: 0,
      maxLevel,
      sources: [{ source, license: 'public-domain', attribution: { text: 'Made with Natural Earth' } }],
    };
    const { tiles, bytes } = await packages.estimate(request);
    list([['Installing', `${String(tiles)} tiles, about ${(bytes / MB).toFixed(1)} MB`]]);
    progress(0);
    await packages.install(request, {
      signal: context.signal,
      onProgress: ({ loadedBytes, totalBytes }) => progress(totalBytes > 0 ? loadedBytes / totalBytes : undefined),
    });
    progress(undefined);
    await listPackages(packages, list);
  };
  const failed = (error: unknown): void => {
    progress(undefined);
    list([['Install', error instanceof Error ? error.message : String(error)]]);
  };
  group.buttons(
    ['Install the view', () => void install().catch(failed)],
    [
      'Remove them',
      () =>
        void packages
          .list()
          .then((all) => Promise.all(all.map((p) => packages.remove(p.id))))
          .then(() => listPackages(packages, list)),
    ],
  );
  void packages.ready.then(() => listPackages(packages, list));
}

/** The offline engine over the fixture imagery. */
export const offline: SceneModule = {
  code: `import { createOffline, createPackageManager } from '@vibeglobe/offline';

const offline = createOffline({ mode: 'hybrid' }); // 'online', 'hybrid' or 'offline'
const packages = createPackageManager(offline, {
  onChange: ({ sourceIds }) => sourceIds.forEach((id) => globe.reloadSource(id)),
});
globe.imageryLayers.add(offline.source(tiles)); // cache → packages → network
await packages.install({ id: 'alps', version: '1', area, minLevel: 0, maxLevel: 10, sources: [{ source: tiles, license, attribution }] });
offline.setMode('offline'); // no request leaves the page`,
  start(context) {
    const { globe, panel } = context;
    const stats = panel.readout();
    const show = (): void => {
      const s = offline.stats(SOURCE_ID);
      stats([
        ['Network', `${offline.mode} · ${offline.connectivity}`],
        ['From the network', `${String(s.network)} tiles · ${(s.networkBytes / MB).toFixed(2)} MB`],
        ['From packages', `${String(s.package)} tiles`],
        ['From the cache', `${String(s.persistent + s.revalidated)} tiles`],
        ['Missing offline', String(s.offlineMisses)],
      ]);
    };
    let pending = 0;
    const offline = createOffline({
      mode: 'hybrid',
      onServe: () => void (pending ||= requestAnimationFrame(() => ((pending = 0), show()))),
    });
    const packages = createPackageManager(offline, {
      database: 'vibeglobe-showcase',
      onChange: ({ sourceIds }) => sourceIds.forEach((id) => globe.reloadSource(id)),
    });
    offline.on('mode-change', ({ sourceIds }) =>
      sourceIds.forEach((id) => globe.reloadSource(id, { missingOnly: true })),
    );
    context.defer(() => {
      cancelAnimationFrame(pending);
      packages.destroy();
      offline.destroy();
    });
    const source = xyzImagery({
      id: SOURCE_ID,
      url: `${location.origin}${import.meta.env.BASE_URL}fixture-tiles/showcase/earth-package/mercator/{z}/{x}/{y}.png`,
      maxLevel: 12,
      attribution: [{ text: 'Made with Natural Earth' }],
    });
    context.imagery(offline.source(source));
    context.go({ longitudeDeg: 10.5, latitudeDeg: 45, zoom: 5.2, tiltDeg: 0, headingDeg: 0 });
    panel.choice(
      'Network mode',
      [
        ['online', 'Online'],
        ['hybrid', 'Hybrid'],
        ['offline', 'Offline'],
      ],
      'hybrid',
      (mode: NetworkMode) => {
        offline.setMode(mode);
        show();
      },
    );
    show();
    packageControls(context, packages, source);
    panel.note(
      'Install the view, switch to Offline and pan: the package and the cache draw the map, nothing is requested.',
    );
  },
};
