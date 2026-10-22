// Every published package must import safely under server-side rendering (PLAN.md fixed constraint): no access to
// browser or GPU globals at import time. Each guarded global throws when touched while the packages are imported.
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readWorkspace } from './workspace.ts';

const BROWSER_GLOBALS = [
  'window',
  'document',
  'navigator',
  'self',
  'location',
  'localStorage',
  'indexedDB',
  'requestAnimationFrame',
  'HTMLElement',
  'customElements',
  'OffscreenCanvas',
  'WebGL2RenderingContext',
  'GPU',
  'fetch',
];

const touched: string[] = [];
const saved = new Map<string, PropertyDescriptor | undefined>();

beforeAll(async () => {
  // Framework peers are the host application's, not the engine's: Vue's runtime feature-detects `typeof window` at
  // import, which the guards below would count. It loads first; the adapter's own code stays guarded.
  // Resolved from the adapter, the only package that depends on it.
  await import(createRequire(new URL('../packages/vue/package.json', import.meta.url)).resolve('vue'));
  for (const name of BROWSER_GLOBALS) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        touched.push(name);
        throw new Error(`${name} was accessed while importing a package`);
      },
    });
  }
});

afterAll(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const packageNames = readWorkspace()
  .filter((pkg) => pkg.dir.startsWith('packages/') && !pkg.manifest.private)
  .map((pkg) => pkg.manifest.name as string);

describe('server-side rendering import safety', () => {
  it('covers every library package', () => {
    expect(packageNames).toHaveLength(12);
  });

  it.each(packageNames)('imports %s without touching browser or GPU globals', async (name) => {
    touched.length = 0;
    await expect(import(/* @vite-ignore */ name)).resolves.toBeDefined();
    expect(touched).toEqual([]);
  });
});
