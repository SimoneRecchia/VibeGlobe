import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT_DIR } from '../workspace.ts';
import { assetProblems, freshDir, inspectPackage } from './tarballs.ts';

function fakePackage(files: Record<string, string>): string {
  const root = freshDir('inspect');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const manifest = JSON.stringify({
  type: 'module',
  license: 'PolyForm-Noncommercial-1.0.0',
  types: './dist/index.d.ts',
  exports: { '.': { types: './dist/index.d.ts', source: './src/index.ts', default: './dist/index.js' } },
});

describe('inspectPackage (F530)', () => {
  it('accepts an ESM package with declarations, its license and maps inside the tarball', () => {
    const root = fakePackage({
      'package.json': manifest,
      'src/index.ts': 'export const a = 1;',
      'dist/index.js': "export { b } from './b.js';",
      'dist/b.js': 'export const b = 1;',
      'dist/index.d.ts': 'export declare const a = 1;',
      'dist/index.js.map': JSON.stringify({ sources: ['../src/index.ts'] }),
    });
    cpSync(join(ROOT_DIR, 'LICENSE.md'), join(root, 'LICENSE.md'));
    expect(inspectPackage(root)).toEqual([]);
  });

  it('reports CommonJS, missing targets and license, and references outside the package', () => {
    const root = fakePackage({
      'package.json': manifest,
      'dist/index.js': "import '../../core/src/x.js'; module.exports = {};",
      'dist/index.js.map': JSON.stringify({ sources: ['../src/index.ts'] }),
    });
    expect(inspectPackage(root)).toEqual([
      'LICENSE.md missing',
      'exports (types): ./dist/index.d.ts is not in the tarball',
      'exports (source): ./src/index.ts is not in the tarball',
      'exports (types): ./dist/index.d.ts is not in the tarball',
      'dist/index.js: CommonJS, not ESM',
      'dist/index.js: imports ../../core/src/x.js, outside the package',
      'dist/index.js.map: source ../src/index.ts is not in the tarball',
    ]);
  });
});

describe('assetProblems (F519)', () => {
  const assets = [
    {
      package: '@vibeglobe/tools',
      path: 'configs/*.json',
      source: 'VibeGlobe',
      license: 'PolyForm-Noncommercial-1.0.0',
    },
    {
      package: '@vibeglobe/tools',
      path: 'data/outline.geojson',
      source: 'Natural Earth',
      license: 'Public domain',
      notice: 'Made with Natural Earth.',
    },
    {
      package: '@vibeglobe/tools',
      path: 'fonts/*.woff2',
      source: 'A foundry',
      license: 'OFL-1.1',
      notice: 'Font notice',
    },
    {
      package: '@vibeglobe/tools',
      path: 'data/tiles.pmtiles',
      source: 'Someone',
      license: 'CC-BY-NC-4.0',
      notice: 'x',
    },
  ];

  it('accepts recorded, permissively licensed assets that are in the notices, and ignores code', () => {
    const root = fakePackage({
      'dist/index.js': '',
      'configs/world.json': '{}',
      'data/outline.geojson': '{}',
      'fonts/sans.woff2': '',
    });
    expect(assetProblems('@vibeglobe/tools', root, assets, 'Made with Natural Earth.\nFont notice')).toEqual([]);
  });

  it('reports unrecorded assets, licenses that are not permitted and assets missing from the notices', () => {
    const root = fakePackage({ 'data/outline.geojson': '{}', 'data/tiles.pmtiles': '', 'icons/pin.svg': '' });
    expect(assetProblems('@vibeglobe/tools', root, assets, '').sort()).toEqual([
      'data/outline.geojson: missing from THIRD_PARTY_NOTICES.md',
      'data/tiles.pmtiles: license CC-BY-NC-4.0 is not permitted',
      'data/tiles.pmtiles: missing from THIRD_PARTY_NOTICES.md',
      'icons/pin.svg: a shipped asset with no record in scripts/release/assets.json',
    ]);
  });
});
