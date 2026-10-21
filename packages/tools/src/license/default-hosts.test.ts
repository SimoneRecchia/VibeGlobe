import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * F344: the engine's default configuration and its built bundles reference no paid or restricted service. Optional
 * adapters for such services (provider profiles, added in M7) live in files named `*-provider*` and are allowed to.
 */
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const RESTRICTED =
  /\b[\w.-]*(google(apis)?\.com|gstatic\.com|mapbox\.com|maptiler\.com|cesium\.com|apple\.com|arcgisonline\.com|arcgis\.com|virtualearth\.net|here\.com|hereapi\.com|tomtom\.com|tile\.openstreetmap\.org)\b/gi;
const OPTIONAL_ADAPTER = /-provider/;

function files(dir: string, extensions: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : files(path, extensions);
    return extensions.test(name) && !/\.(test|spec)\.|\.d\.ts$|\.map$/.test(name) ? [path] : [];
  });
}

/** The engine's shipped code: each package's build when present, else its sources (the tools CLI is not shipped). */
function engineCode(): string[] {
  return readdirSync(join(ROOT, 'packages'))
    .filter((name) => name !== 'tools')
    .flatMap((name) => {
      const dist = join(ROOT, 'packages', name, 'dist');
      return existsSync(dist) ? files(dist, /\.js$/) : files(join(ROOT, 'packages', name, 'src'), /\.ts$/);
    });
}

function hits(paths: string[]): string[] {
  return paths
    .filter((path) => !OPTIONAL_ADAPTER.test(path))
    .flatMap((path) =>
      [...readFileSync(path, 'utf8').matchAll(RESTRICTED)].map((m) => `${path.slice(ROOT.length)}: ${m[0]}`),
    );
}

describe('default configuration and bundles', () => {
  it('the engine packages and the playground bundle reference no paid or restricted host', () => {
    const code = [...engineCode(), ...files(join(ROOT, 'apps', 'playground', 'dist'), /\.(js|html)$/)];
    expect(code.length).toBeGreaterThan(10);
    expect(hits(code)).toEqual([]);
  });

  it('the shipped pipeline configurations download only from the consumers’ chosen free sources', () => {
    const configs = files(join(ROOT, 'packages', 'tools', 'configs'), /\.json$/);
    expect(configs.length).toBeGreaterThan(0);
    expect(hits(configs)).toEqual([]);
  });
});
