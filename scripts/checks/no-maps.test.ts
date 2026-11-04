// F701: the library ships no map and no provider (ADR 0187). No published package is a provider or preset package, and
// no published package's code names a map or geocoding host: the application brings its tiles, terrain and places.
// The data pipeline (`@vibeglobe/tools`) is left out: its configurations name the open datasets it builds from.
import { describe, expect, it } from 'vitest';
import { readWorkspace } from '../workspace.ts';

const MAP_HOSTS =
  /\b(tiles\.openfreemap\.org|tiles\.mapterhorn\.com|gibs\.earthdata\.nasa\.gov|tile\.openstreetmap\.org|api\.maptiler\.com|arcgisonline\.com|arcgis\.com|photon\.komoot\.io|api\.protomaps\.com)\b/;

const published = readWorkspace().filter((pkg) => pkg.dir.startsWith('packages/') && !pkg.manifest.private);

describe('no map and no provider in the library (F701)', () => {
  it('publishes no provider or preset package', () => {
    const names = published.map((pkg) => pkg.manifest.name);
    expect(names).toContain('@vibeglobe/core');
    expect(names.filter((name) => /providers|presets/.test(String(name)))).toEqual([]);
  });

  it("names no map or geocoding host in any published package's code", () => {
    const hits = published
      .filter((pkg) => pkg.dir !== 'packages/tools')
      .flatMap((pkg) => pkg.sources)
      .filter((file) => !/\.(test|spec)\.ts$/.test(file.path) && MAP_HOSTS.test(file.content))
      .map((file) => `${file.path}: ${MAP_HOSTS.exec(file.content)?.[0]}`);
    expect(hits).toEqual([]);
  });
});
