import type { Globe } from '@vibeglobe/core';

/** The debug overlay's lines of each imagery source's declared metadata (F220). */
export function sourceLines(globe: Globe): [string, string][] {
  return globe.imageryLayers
    .list()
    .flatMap((layer) =>
      layer.sources.map((source): [string, string] => [
        `source-${source.id}`,
        `source ${source.id} ${source.crs} z${source.minLevel}–${source.maxLevel} ${source.tileSizePx}px` +
          (source.maxRequestsPerSecond ? ` ${source.maxRequestsPerSecond}/s` : '') +
          `${source.keepInMemory ? ' cache' : ''}${source.prefetch ? ' prefetch' : ''}${source.authenticated ? ' auth' : ''}`,
      ]),
    );
}
