import { describe, expect, it } from 'vitest';
import type { WorkspacePackage } from '../workspace.ts';
import { importSpecifiers, packageNameOf } from '../workspace.ts';
import { findDependencyViolations } from './dependencies.ts';
import { findHotPathViolations } from './hot-paths.ts';
import { LIBRARY_PACKAGES, findStructureViolations } from './structure.ts';

function pkg(
  dir: string,
  overrides: Partial<WorkspacePackage> = {},
  sources: Record<string, string> = {},
): WorkspacePackage {
  const folder = dir.split('/')[1];
  const files = [`${dir}/package.json`, `${dir}/CLAUDE.md`, `${dir}/src/index.ts`, ...Object.keys(sources)];
  return {
    dir,
    manifest: { name: `@vibeglobe/${folder}`, type: 'module', sideEffects: false },
    files,
    sources: Object.entries(sources).map(([path, content]) => ({ path, content })),
    ...overrides,
  };
}

const validWorkspace = (): WorkspacePackage[] => [
  ...LIBRARY_PACKAGES.map((name) => pkg(`packages/${name}`)),
  pkg('apps/playground'),
];

function find(workspace: WorkspacePackage[], dir: string): WorkspacePackage {
  const found = workspace.find((p) => p.dir === dir);
  if (!found) throw new Error(`no package ${dir}`);
  return found;
}

describe('workspace helpers', () => {
  it('extracts static, dynamic, side-effect and re-export specifiers', () => {
    const source = `import a from 'a';\nimport { b } from "@scope/b/sub";\nimport 'c';\nexport { d } from './d.js';\nconst e = await import('e/x');`;
    expect(importSpecifiers(source)).toEqual(['a', '@scope/b/sub', 'c', './d.js', 'e/x']);
  });

  it('maps specifiers to package names', () => {
    expect(packageNameOf('three/webgpu')).toBe('three');
    expect(packageNameOf('@vue/runtime-dom/dist')).toBe('@vue/runtime-dom');
    expect(packageNameOf('./local.js')).toBeUndefined();
    expect(packageNameOf('node:fs')).toBeUndefined();
  });
});

describe('findStructureViolations', () => {
  it('accepts the expected layout', () => {
    expect(findStructureViolations(validWorkspace())).toEqual([]);
  });

  it('reports missing packages, files, names and misplaced tests', () => {
    const workspace = validWorkspace().filter((p) => p.dir !== 'packages/tools');
    const ui = find(workspace, 'packages/ui');
    ui.files = ui.files.filter((file) => !file.endsWith('CLAUDE.md')).concat('packages/ui/test/ui.test.ts');
    const core = find(workspace, 'packages/core');
    core.manifest = { name: '@vibeglobe/Core', sideEffects: ['./src/polyfill.ts'] };
    expect(findStructureViolations(workspace)).toEqual([
      'packages/tools: missing package',
      'packages/core: package name must be "@vibeglobe/core"',
      'packages/core: package.json must declare "type": "module"',
      'packages/core: package.json must declare "sideEffects": false',
      'packages/ui: missing CLAUDE.md',
      'packages/ui/test/ui.test.ts: tests live next to the code they test, not in a test folder',
      'packages/ui/test/ui.test.ts: tests live next to the code they test, inside src/',
    ]);
  });

  it('reports a renamed package folder', () => {
    const workspace = validWorkspace().map((p) => (p.dir === 'packages/layers' ? pkg('packages/Layers') : p));
    expect(findStructureViolations(workspace)).toEqual([
      'packages/layers: missing package',
      'packages/Layers: package folder names must be lowercase',
    ]);
  });
});

describe('findDependencyViolations', () => {
  it('accepts frameworks in their adapter and the rendering library in the renderer', () => {
    const workspace = [
      pkg(
        'packages/vue',
        { manifest: { name: '@vibeglobe/vue', type: 'module', peerDependencies: { vue: '3.5.0' } } },
        { 'packages/vue/src/index.ts': "import { ref } from 'vue';" },
      ),
      pkg(
        'packages/renderer',
        { manifest: { name: '@vibeglobe/renderer', type: 'module', dependencies: { three: '0.186.1' } } },
        { 'packages/renderer/src/index.ts': "import { WebGPURenderer } from 'three/webgpu';" },
      ),
      pkg('packages/core', {}, { 'packages/core/src/a.test.ts': "import { it } from 'vitest';" }),
    ];
    expect(findDependencyViolations(workspace)).toEqual([]);
  });

  it('reports frameworks, the consumer app, the rendering library and core runtime dependencies', () => {
    const workspace = [
      pkg(
        'packages/core',
        { manifest: { name: '@vibeglobe/core', type: 'module', dependencies: { lodash: '1.0.0' } } },
        { 'packages/core/src/a.ts': "import { ref } from 'vue';\nimport * as THREE from 'three';" },
      ),
      pkg('packages/web-component', {
        manifest: {
          name: '@vibeglobe/web-component',
          type: 'module',
          dependencies: { react: '19.0.0', '@vireox/cube': '1.0.0' },
        },
      }),
    ];
    expect(findDependencyViolations(workspace)).toEqual([
      'packages/core/src/a.ts: "three" may only be used inside packages/renderer',
      'packages/core/src/a.ts: framework "vue" is only allowed in its adapter package',
      'packages/core/package.json: core must have no runtime dependencies ("lodash")',
      'packages/core/src/a.ts: core must not import "vue" at runtime',
      'packages/core/src/a.ts: core must not import "three" at runtime',
      'packages/web-component/package.json: "@vireox/cube" refers to a consumer application; the engine must not depend on it',
      'packages/web-component/package.json: framework "react" is only allowed in its adapter package',
    ]);
  });
});

describe('findHotPathViolations', () => {
  const exists = (path: string): boolean => path === 'benchmarks/frame-loop.bench.ts';

  it('accepts a documented hot-path module', () => {
    const content =
      '/**\n * @hotpath Runs every frame for every tile.\n * @benchmark benchmarks/frame-loop.bench.ts\n */\nexport const x = 1;';
    expect(findHotPathViolations([{ path: 'packages/core/src/a.hot.ts', content }], exists)).toEqual([]);
  });

  it('reports missing reasons, missing or unknown benchmarks and misnamed modules', () => {
    const sources = [
      { path: 'packages/core/src/a.hot.ts', content: 'export const a = 1;' },
      {
        path: 'packages/core/src/b.hot.ts',
        content: '/**\n * @hotpath Tight loop.\n * @benchmark benchmarks/missing.bench.ts\n */',
      },
      { path: 'packages/core/src/c.ts', content: '/** @hotpath Tight loop. */' },
    ];
    expect(findHotPathViolations(sources, exists)).toEqual([
      'packages/core/src/a.hot.ts: header must state "@hotpath <reason>"',
      'packages/core/src/a.hot.ts: header must name "@benchmark <path>"',
      'packages/core/src/b.hot.ts: benchmark "benchmarks/missing.bench.ts" does not exist',
      'packages/core/src/c.ts: @hotpath modules must be named *.hot.ts',
    ]);
  });
});
