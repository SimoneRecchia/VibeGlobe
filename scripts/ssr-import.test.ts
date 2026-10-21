// Every published package must import safely under server-side rendering (PLAN.md fixed constraint): no access to
// browser or GPU globals at import time. Each guarded global throws when touched while the packages are imported.
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

beforeAll(() => {
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
    expect(packageNames).toHaveLength(11);
  });

  it.each(packageNames)('imports %s without touching browser or GPU globals', async (name) => {
    touched.length = 0;
    await expect(import(/* @vite-ignore */ name)).resolves.toBeDefined();
    expect(touched).toEqual([]);
  });
});
