import { importSpecifiers, packageNameOf, type WorkspacePackage } from '../workspace.ts';

const FRAMEWORK_PACKAGE = /^(vue|nuxt|react|react-dom|preact|svelte|solid-js|@vue\/.*|@nuxt\/.*|@angular\/.*)$/;
const CONSUMER_PACKAGE = /cube|vireox/i;
/** The only framework a package may use, by package directory. */
const ALLOWED_FRAMEWORKS: Record<string, string[]> = {
  'packages/vue': ['vue', '@vue/*'],
  'apps/nuxt-example': ['vue', '@vue/*', 'nuxt', '@nuxt/*'],
};
const RENDERING_LIBRARY = 'three';
const RENDERER_DIR = 'packages/renderer';

function allowedFramework(dir: string, name: string): boolean {
  return (ALLOWED_FRAMEWORKS[dir] ?? []).some((allowed) =>
    allowed.endsWith('/*') ? name.startsWith(allowed.slice(0, -1)) : name === allowed,
  );
}

/**
 * Architecture dependency rules (docs/plan/architecture.md §1): no framework outside its adapter, nothing depends on
 * the consumer application, the rendering library only inside the renderer, and core has no runtime dependencies.
 */
export function findDependencyViolations(packages: WorkspacePackage[]): string[] {
  const violations: string[] = [];
  for (const pkg of packages) {
    const declared = {
      ...pkg.manifest.dependencies,
      ...pkg.manifest.peerDependencies,
      ...pkg.manifest.devDependencies,
    };
    const used = new Map<string, string>();
    for (const source of pkg.sources) {
      for (const specifier of importSpecifiers(source.content)) {
        const name = packageNameOf(specifier);
        if (name && !used.has(name)) used.set(name, source.path);
      }
    }
    const names = new Set([...Object.keys(declared), ...used.keys()]);
    for (const name of [...names].sort()) {
      const where = used.get(name) ?? `${pkg.dir}/package.json`;
      if (FRAMEWORK_PACKAGE.test(name) && !allowedFramework(pkg.dir, name))
        violations.push(`${where}: framework "${name}" is only allowed in its adapter package`);
      if (CONSUMER_PACKAGE.test(name))
        violations.push(`${where}: "${name}" refers to a consumer application; the engine must not depend on it`);
      if (name === RENDERING_LIBRARY && pkg.dir !== RENDERER_DIR && pkg.dir.startsWith('packages/')) {
        violations.push(`${where}: "${name}" may only be used inside ${RENDERER_DIR}`);
      }
    }
    if (pkg.dir === 'packages/core') {
      for (const name of Object.keys({ ...pkg.manifest.dependencies, ...pkg.manifest.peerDependencies })) {
        violations.push(`packages/core/package.json: core must have no runtime dependencies ("${name}")`);
      }
      for (const source of pkg.sources.filter((file) => !file.path.endsWith('.test.ts'))) {
        for (const specifier of importSpecifiers(source.content)) {
          const name = packageNameOf(specifier);
          if (name) violations.push(`${source.path}: core must not import "${name}" at runtime`);
        }
      }
    }
  }
  return violations;
}
