// The browser checks of each feature group's page (F488), run by e2e/nuxt-features.spec.ts through
// `window.featureChecks`. Loaded on the client only, after the globe is ready.
import type { Globe } from '@vibeglobe/core';
import type { GlobeExtras } from '@vibeglobe/vue';

/** A named check of a page: resolves true when the feature works. */
export type Checks = Record<string, () => Promise<boolean>>;

/** What a page hands its checks. */
export interface CheckContext {
  readonly globe: Globe;
  readonly extras: GlobeExtras;
  readonly offline?: {
    readonly mode: string;
    setMode(mode: 'online' | 'offline' | 'hybrid'): void;
    stats(id?: string): { network: number };
  };
}

/** Resolves once the engine has drawn every frame it asked for (no frame for 300 ms). */
function idle(globe: Globe): Promise<void> {
  return new Promise((resolve) => {
    let timer = setTimeout(done, 300);
    const stop = globe.on('frame', () => {
      clearTimeout(timer);
      timer = setTimeout(done, 300);
    });
    function done(): void {
      stop();
      resolve();
    }
    globe.requestRender();
  });
}

const near = (a: number, b: number, tolerance = 1e-6): boolean => Math.abs(a - b) <= tolerance;

/** Whether the frame's center pixel is opaque (drawn). */
async function drawnCenter(globe: Globe): Promise<boolean> {
  const frame = await globe.captureFrame();
  const i = ((frame.heightPx >> 1) * frame.widthPx + (frame.widthPx >> 1)) * 4;
  return (frame.rgba[i + 3] ?? 0) === 255;
}

const GROUP_CHECKS: Record<string, (context: CheckContext) => Checks> = {
  'map-experience': ({ globe }) => ({
    'view modes': async () => {
      globe.setViewMode('2d');
      await idle(globe);
      const flat = globe.viewMode === '2d' && near(globe.camera.tiltDeg, 0);
      globe.setViewMode('auto');
      await idle(globe);
      return flat && globe.viewMode === 'auto';
    },
    'globe to flat': async () => {
      globe.jumpTo({ zoom: 1.5 });
      await idle(globe);
      const globePhase = globe.camera.phase === 'globe';
      globe.jumpTo({ zoom: 13 });
      await idle(globe);
      return globePhase && globe.camera.phase !== 'globe' && globe.camera.morphFactor > 0.5;
    },
  }),
  navigation: ({ globe }) => ({
    'fly to': async () =>
      (await globe.flyTo({ longitudeDeg: 2.35, latitudeDeg: 48.85, zoom: 9 }, { durationMs: 800 })) === 'completed' &&
      near(globe.camera.longitudeDeg, 2.35),
    'fit bounds': async () => {
      await globe.fitBounds({ westDeg: 6, southDeg: 36, eastDeg: 19, northDeg: 47 }, { durationMs: 500 });
      const { longitudeDeg: lon, latitudeDeg: lat } = globe.camera;
      return lon > 6 && lon < 19 && lat > 36 && lat < 47;
    },
    'zoom control': async () => {
      const button = document.querySelector<HTMLButtonElement>('.vg-ui__button--zoom-in');
      const before = globe.camera.zoom;
      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 600));
      await idle(globe);
      return button !== null && near(globe.camera.zoom, before + 1, 1e-3);
    },
  }),
  rendering: ({ globe }) => ({
    'complete frame': () => drawnCenter(globe),
    'resolution scale': async () => {
      const full = (await globe.captureFrame()).widthPx;
      globe.setResolutionScale(0.5);
      await idle(globe);
      const half = (await globe.captureFrame()).widthPx;
      globe.setResolutionScale(1);
      await idle(globe);
      return Math.abs(half - full / 2) <= 1;
    },
  }),
  tiles: ({ globe }) => ({
    'tiles streamed': async () => {
      globe.jumpTo({ longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 6 });
      await idle(globe);
      const stats = globe.imageryStats();
      return stats !== undefined && stats.ready > 0 && stats.failed === 0 && globe.surfaceStats().onBaseImage === 0;
    },
  }),
  sources: ({ globe }) => ({
    'application adapter and credits': async () => {
      await idle(globe);
      return globe.credits().some((credit) => credit.text === 'Generated tiles');
    },
    'layer looks': async () => {
      globe.imageryLayers.set('generated', { opacity: 0.4 });
      const changed = globe.imageryLayers.list()[0]?.opacity === 0.4;
      globe.imageryLayers.set('generated', { opacity: 1 });
      return changed;
    },
  }),
  offline: ({ globe, offline }) => ({
    'network modes': async () => {
      if (offline === undefined) return false;
      offline.setMode('offline');
      const isOffline = offline.mode === 'offline';
      offline.setMode('hybrid');
      return isOffline && offline.mode === 'hybrid';
    },
    'tile tiers': async () => {
      await idle(globe);
      return (offline?.stats('generated').network ?? 0) > 0;
    },
  }),
  'data-layers': ({ globe, extras }) => ({
    'point layer and marker': async () => {
      const { stack } = await extras.layers();
      await idle(globe);
      return stack.order.length === 2 && globe.resourceCounts().meshes > 0;
    },
  }),
  gis: ({ globe }) => ({
    'coordinates and measurement': async () => {
      const gis = await import('@vibeglobe/gis');
      const text = gis.formatCoordinate({ longitudeDeg: 7.6869, latitudeDeg: 45.0703 }, 'dms');
      const parsed = text === undefined ? undefined : gis.parseCoordinate(text);
      const distance = gis.measureDistance({ longitudeDeg: 0, latitudeDeg: 0 }, { longitudeDeg: 1, latitudeDeg: 0 });
      return (
        parsed !== undefined && near(parsed.latitudeDeg, 45.0703, 1e-3) && near(distance.distanceMeters, 111319.5, 1)
      );
    },
    'view state in URLs': async () => {
      const gis = await import('@vibeglobe/gis');
      const view = gis.viewStateOf(globe.camera);
      const back = view === undefined ? undefined : gis.viewStateFromUrl(gis.viewStateToUrl(location.href, view));
      return back !== undefined && back.zoom === view?.zoom;
    },
  }),
  ui: ({ extras }) => ({
    'controls and languages': async () => {
      const ui = await extras.ui();
      ui.setLanguage('it');
      const italian = document.querySelector('.vg-ui__button--zoom-in')?.getAttribute('aria-label') === 'Ingrandisci';
      ui.setLanguage('en');
      return ui.controls().length >= 3 && italian;
    },
  }),
  debugging: ({ globe }) => ({
    'phase timing and counters': async () => {
      globe.diagnostics.setPhaseTiming(true, false);
      globe.jumpTo({ zoom: globe.camera.zoom + 0.1 });
      await idle(globe);
      const times = globe.diagnostics.phaseTimesMs();
      globe.diagnostics.setPhaseTiming(false);
      return times.render >= 0 && globe.surfaceStats().tiles > 0 && globe.rendererStats().drawCalls > 0;
    },
  }),
  security: () => ({
    'no third-party requests': async () =>
      performance
        .getEntriesByType('resource')
        .every(
          (entry) => new URL(entry.name, location.href).origin === location.origin || entry.name.startsWith('data:'),
        ),
    'CSP-safe styles': async () =>
      document.adoptedStyleSheets.length > 0 && document.querySelector('style[data-vg]') === null,
  }),
};

/** The checks of a feature group's page. */
export function checksFor(group: string, context: CheckContext): Checks {
  return GROUP_CHECKS[group]?.(context) ?? {};
}
